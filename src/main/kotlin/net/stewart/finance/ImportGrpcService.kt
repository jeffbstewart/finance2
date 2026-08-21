package net.stewart.finance

import io.grpc.Status
import io.grpc.StatusException
import java.time.format.DateTimeFormatter
import net.stewart.armeria.auth.currentAuthUser
import net.stewart.finance.api.SnapshotImportService
import net.stewart.finance.api.toFormattedDate
import net.stewart.finance.db.AccountRepository
import net.stewart.finance.db.PlaidAccountLinkRepository
import net.stewart.finance.db.PortfolioRepository
import net.stewart.finance.db.SnapshotRecord
import net.stewart.finance.db.SnapshotRepository
import net.stewart.finance.domain.AccountId
import net.stewart.finance.domain.PortfolioId
import net.stewart.finance.domain.SnapshotId
import net.stewart.finance.domain.SnapshotStatus
import net.stewart.finance.domain.UserId
import net.stewart.finance.proto.DeleteSnapshotRequest
import net.stewart.finance.proto.DeleteSnapshotResponse
import net.stewart.finance.proto.GetSnapshotAccountsRequest
import net.stewart.finance.proto.GetSnapshotAccountsResponse
import net.stewart.finance.proto.ImportReport
import net.stewart.finance.proto.ImportServiceGrpcKt
import net.stewart.finance.proto.LinkPlaidAccountRequest
import net.stewart.finance.proto.LinkPlaidAccountResponse
import net.stewart.finance.proto.ListSnapshotsRequest
import net.stewart.finance.proto.ListSnapshotsResponse
import net.stewart.finance.proto.PlaidAccountView
import net.stewart.finance.proto.ProcessSnapshotRequest
import net.stewart.finance.proto.ProcessSnapshotResponse
import net.stewart.finance.proto.SnapshotRow
import net.stewart.finance.proto.SnapshotStatus as SnapshotStatusProto
import net.stewart.finance.proto.UploadSnapshotRequest
import net.stewart.finance.proto.UploadSnapshotResponse

/** Uploads larger than this are refused — snapshots are small. */
private const val MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024

/**
 * ImportService (pipeline design §E, amended 2026-08-20): archive
 * bankferry snapshots uploaded through the authenticated browser
 * session, link Plaid accounts to finance2 accounts, and run the
 * freely repeatable processor.
 */
class ImportGrpcService(
    private val portfolios: PortfolioRepository,
    private val accounts: AccountRepository,
    private val links: PlaidAccountLinkRepository,
    private val snapshots: SnapshotRepository,
    private val importer: SnapshotImportService,
) : ImportServiceGrpcKt.ImportServiceCoroutineImplBase() {

    override suspend fun uploadSnapshot(request: UploadSnapshotRequest): UploadSnapshotResponse {
        if (request.content.size() > MAX_SNAPSHOT_BYTES) {
            throw invalid("snapshot exceeds ${MAX_SNAPSHOT_BYTES / (1024 * 1024)} MB")
        }
        val record = importer.upload(portfolio(), request.filename, request.content.toByteArray())
        return UploadSnapshotResponse.newBuilder().setSnapshot(record.toProto()).build()
    }

    override suspend fun listSnapshots(request: ListSnapshotsRequest): ListSnapshotsResponse {
        val builder = ListSnapshotsResponse.newBuilder()
        for (record in snapshots.list(portfolio())) {
            builder.addSnapshots(record.toProto())
        }
        return builder.build()
    }

    override suspend fun processSnapshot(request: ProcessSnapshotRequest): ProcessSnapshotResponse {
        val record = importer.process(portfolio(), snapshotId(request.snapshotId))
        return ProcessSnapshotResponse.newBuilder().setSnapshot(record.toProto()).build()
    }

    override suspend fun deleteSnapshot(request: DeleteSnapshotRequest): DeleteSnapshotResponse {
        val portfolioId = portfolio()
        val id = snapshotId(request.snapshotId)
        if (snapshots.find(id, portfolioId) == null) {
            throw StatusException(Status.NOT_FOUND.withDescription("no snapshot ${request.snapshotId}"))
        }
        snapshots.delete(id)
        return DeleteSnapshotResponse.getDefaultInstance()
    }

    override suspend fun getSnapshotAccounts(
        request: GetSnapshotAccountsRequest,
    ): GetSnapshotAccountsResponse {
        val builder = GetSnapshotAccountsResponse.newBuilder()
        for ((institution, plaidAccount, linked) in
            importer.snapshotAccounts(portfolio(), snapshotId(request.snapshotId))
        ) {
            val view = PlaidAccountView.newBuilder()
                .setAccountRef(plaidAccount.accountRef)
                .setInstitutionEntry(institution)
                .setName(plaidAccount.name)
                .setOfficialName(plaidAccount.officialName)
                .setMask(plaidAccount.mask)
                .setType(plaidAccount.type)
                .setSubtype(plaidAccount.subtype)
                .setHoldings(plaidAccount.holdingsCount)
            if (linked != null) {
                view.setLinkedAccountId(linked.id.value)
                    .setLinkedAccountName("${linked.brokerName} : ${linked.name}")
            }
            builder.addAccounts(view)
        }
        return builder.build()
    }

    override suspend fun linkPlaidAccount(request: LinkPlaidAccountRequest): LinkPlaidAccountResponse {
        val accountRef = request.accountRef.trim()
        if (accountRef.isEmpty()) throw invalid("account ref is required")
        if (accountRef.length > 128) throw invalid("account ref exceeds 128 characters")
        if (request.accountId == 0L) {
            links.unlink(accountRef)
            return LinkPlaidAccountResponse.getDefaultInstance()
        }
        val account = accounts.find(AccountId(request.accountId), portfolio())
            ?: throw StatusException(Status.NOT_FOUND.withDescription("no account ${request.accountId}"))
        links.link(accountRef, account.id)
        return LinkPlaidAccountResponse.getDefaultInstance()
    }

    private fun SnapshotRecord.toProto(): SnapshotRow {
        val builder = SnapshotRow.newBuilder()
            .setSnapshotId(id.value)
            .setFilename(filename)
            .setUploadedAt(uploadedAt.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME))
            .setAsOf(asOf.toFormattedDate())
            .setSchemaVersion(schemaVersion)
            .setStatus(status.toProto())
        processedAt?.let { builder.setProcessedAt(it.format(DateTimeFormatter.ISO_OFFSET_DATE_TIME)) }
        report?.let { builder.setReport(ImportReport.parseFrom(it)) }
        return builder.build()
    }

    private fun SnapshotStatus.toProto(): SnapshotStatusProto = when (this) {
        SnapshotStatus.UPLOADED -> SnapshotStatusProto.UPLOADED
        SnapshotStatus.PROCESSED -> SnapshotStatusProto.PROCESSED
        SnapshotStatus.FAILED -> SnapshotStatusProto.FAILED
    }

    private fun snapshotId(raw: Long): SnapshotId =
        if (raw > 0) SnapshotId(raw) else throw invalid("snapshot id is required")

    private fun portfolio(): PortfolioId =
        portfolios.portfolioFor(UserId(currentAuthUser().id))

    private fun invalid(message: String) =
        StatusException(Status.INVALID_ARGUMENT.withDescription(message))
}
