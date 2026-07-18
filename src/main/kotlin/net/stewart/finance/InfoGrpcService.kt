package net.stewart.finance

import net.stewart.finance.proto.GetInfoRequest
import net.stewart.finance.proto.GetInfoResponse
import net.stewart.finance.proto.InfoServiceGrpcKt

const val APP_VERSION = "0.1.0"

class InfoGrpcService : InfoServiceGrpcKt.InfoServiceCoroutineImplBase() {
    override suspend fun getInfo(request: GetInfoRequest): GetInfoResponse =
        GetInfoResponse.newBuilder().setVersion(APP_VERSION).build()
}
