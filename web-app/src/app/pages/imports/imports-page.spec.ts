// Unit spec for ImportsPage (docs/design/ui-testing.md, inventory
// "ImportsPage"). Fakes ImportService + AccountService through
// installFakeApi; the hidden file input is driven the way the browser
// drives it (a change event carrying a real File), never by poking
// component fields.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { create } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { AccountService } from '../../../proto-gen/accounts_pb';
import {
  ImportReportSchema,
  ImportService,
  PlaidAccountViewSchema,
  ReportLineSchema,
  ReportSeverity,
  SnapshotRowSchema,
  SnapshotStatus,
  PlaidSecurityViewSchema,
  SecurityMatch,
  type PlaidAccountView,
  type PlaidSecurityView,
  type SnapshotRow,
} from '../../../proto-gen/imports_pb';
import { SecurityService } from '../../../proto-gen/securities_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { sampleAccounts, sampleAllSecurities } from '../../../testing/sample-data';
import { settle } from '../../../testing/settle';
import { date } from '../../../testing/wire';
import { Notify } from '../../core/notify';
import { ImportsPage } from './imports-page';

/** The seeder's archived, unprocessed `vanguard-sample.pb`. */
function uploadedSnapshot(): SnapshotRow {
  return create(SnapshotRowSchema, {
    snapshotId: 10n,
    filename: 'vanguard-sample.pb',
    uploadedAt: '2026-08-18T10:15:32.123456-04:00',
    asOf: date('2026-08-18'),
    schemaVersion: 1,
    status: SnapshotStatus.UPLOADED,
    processedAt: '',
  });
}

/** The same archive after a successful run, carrying its report. */
function processedSnapshot(): SnapshotRow {
  return create(SnapshotRowSchema, {
    snapshotId: 10n,
    filename: 'vanguard-sample.pb',
    uploadedAt: '2026-08-18T10:15:32.123456-04:00',
    asOf: date('2026-08-18'),
    schemaVersion: 1,
    status: SnapshotStatus.PROCESSED,
    processedAt: '2026-08-19T09:00:00Z',
    report: create(ImportReportSchema, {
      holdingsUpdated: 1,
      sweepsUpdated: 1,
      lines: [
        create(ReportLineSchema, {
          severity: ReportSeverity.INFO,
          message: 'Vanguard "Roth IRA" …5678: sweep set to $55.25',
        }),
        create(ReportLineSchema, {
          severity: ReportSeverity.WARNING,
          message:
            'Vanguard "Roth IRA" …5678: GOLD is held here but absent from the ' +
            'snapshot — delete the holding by hand if it was sold',
        }),
      ],
    }),
  });
}

/** An older archive whose last run threw. */
function failedSnapshot(): SnapshotRow {
  return create(SnapshotRowSchema, {
    snapshotId: 9n,
    filename: 'vanguard-prior.pb',
    uploadedAt: '2026-08-01T08:00:00Z',
    asOf: date('2026-08-01'),
    schemaVersion: 1,
    status: SnapshotStatus.FAILED,
    processedAt: '2026-08-01T08:00:05Z',
    report: create(ImportReportSchema, {
      lines: [
        create(ReportLineSchema, {
          severity: ReportSeverity.WARNING,
          message: 'processing failed: boom',
        }),
      ],
    }),
  });
}

/** The freshly uploaded archive the fake returns from uploadSnapshot. */
function newlyUploaded(filename: string): SnapshotRow {
  return create(SnapshotRowSchema, {
    snapshotId: 11n,
    filename,
    uploadedAt: '2026-08-20T12:00:00Z',
    asOf: date('2026-08-20'),
    schemaVersion: 1,
    status: SnapshotStatus.UPLOADED,
  });
}

/** ref-roth is pre-linked to the Roth IRA (account 2, as the seeder
 *  leaves it); ref-brokerage is unlinked, so its select sits on the
 *  bigint-zero sentinel. */
function plaidAccounts(): PlaidAccountView[] {
  return [
    create(PlaidAccountViewSchema, {
      accountRef: 'ref-roth',
      institutionEntry: 'Vanguard',
      name: 'Roth IRA',
      mask: '5678',
      type: 'investment',
      subtype: 'roth',
      holdings: 1,
      linkedAccountId: 2n,
      linkedAccountName: 'Vanguard : Roth IRA',
    }),
    create(PlaidAccountViewSchema, {
      accountRef: 'ref-brokerage',
      institutionEntry: 'Vanguard',
      name: 'Brokerage',
      type: 'investment',
      holdings: 2,
      linkedAccountId: 0n,
    }),
  ];
}

/** VTI matches by ticker; the 401(k) trust fund has no ticker and is
 *  unlinked, so only it gets a select. */
function plaidSecurities(): PlaidSecurityView[] {
  return [
    create(PlaidSecurityViewSchema, {
      plaidSecurityId: 'plaid-sec-vti',
      name: 'Vanguard Total Stock Market ETF',
      ticker: 'VTI',
      cusip: '922908769',
      type: 'etf',
      currencyCode: 'USD',
      accounts: 2,
      match: SecurityMatch.BY_TICKER,
      securityId: 1n,
      securityTicker: 'VTI',
    }),
    create(PlaidSecurityViewSchema, {
      plaidSecurityId: 'plaid-sec-trust',
      name: 'Inst Tot Bd Mkt Ix Tr',
      type: 'mutual fund',
      currencyCode: 'USD',
      accounts: 1,
      match: SecurityMatch.UNMATCHED,
    }),
  ];
}

type Recorded = {
  list: number;
  accounts: bigint[];
  securities: bigint[];
  securityLinks: { plaidSecurityId: string; securityId: bigint }[];
  processed: bigint[];
  deleted: bigint[];
  links: { accountRef: string; accountId: bigint }[];
  uploads: { filename: string; content: Uint8Array }[];
  listAccounts: { includeHidden: boolean }[];
};

describe('ImportsPage', () => {
  let restoreApi: () => void;
  let calls: Recorded;
  let snapshots: SnapshotRow[];
  let accountViews: PlaidAccountView[];
  let securityViews: PlaidSecurityView[];
  let onSecurityLink: () => void;
  let onList: () => void;
  let onGetAccounts: () => void;
  let onLink: () => void;
  let onUpload: (filename: string) => SnapshotRow;
  let onProcess: (id: bigint) => SnapshotRow | Promise<SnapshotRow>;
  let success: MockInstance<(message: string) => void>;
  let error: MockInstance<(err: unknown, fallback?: string) => void>;

  beforeEach(() => {
    calls = {
      list: 0,
      accounts: [],
      securities: [],
      securityLinks: [],
      processed: [],
      deleted: [],
      links: [],
      uploads: [],
      listAccounts: [],
    };
    snapshots = [uploadedSnapshot()];
    accountViews = plaidAccounts();
    securityViews = plaidSecurities();
    onSecurityLink = () => {};
    onList = () => {};
    onGetAccounts = () => {};
    onLink = () => {};
    onProcess = (id) => {
      const row = processedSnapshot();
      snapshots = snapshots.map((s) => (s.snapshotId === id ? row : s));
      return row;
    };
    onUpload = (filename) => {
      const row = newlyUploaded(filename);
      snapshots = [row, ...snapshots];
      return row;
    };

    restoreApi = installFakeApi(({ service }) => {
      service(ImportService, {
        listSnapshots: () => {
          calls.list++;
          onList();
          return { snapshots };
        },
        getSnapshotAccounts: (request) => {
          calls.accounts.push(request.snapshotId);
          onGetAccounts();
          return { accounts: accountViews };
        },
        uploadSnapshot: (request) => {
          calls.uploads.push({ filename: request.filename, content: request.content });
          return { snapshot: onUpload(request.filename) };
        },
        processSnapshot: async (request) => {
          calls.processed.push(request.snapshotId);
          return { snapshot: await onProcess(request.snapshotId) };
        },
        deleteSnapshot: (request) => {
          calls.deleted.push(request.snapshotId);
          snapshots = snapshots.filter((s) => s.snapshotId !== request.snapshotId);
          return {};
        },
        linkPlaidAccount: (request) => {
          calls.links.push({ accountRef: request.accountRef, accountId: request.accountId });
          onLink();
          return {};
        },
        getSnapshotSecurities: (request) => {
          calls.securities.push(request.snapshotId);
          return { securities: securityViews };
        },
        linkPlaidSecurity: (request) => {
          calls.securityLinks.push({
            plaidSecurityId: request.plaidSecurityId,
            securityId: request.securityId,
          });
          onSecurityLink();
          return {};
        },
      });
      service(SecurityService, {
        listSecurities: () => ({ securities: sampleAllSecurities() }),
      });
      service(AccountService, {
        listAccounts: (request) => {
          calls.listAccounts.push({ includeHidden: request.includeHidden });
          return { accounts: sampleAccounts() };
        },
      });
    });

    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    // Stubbing Notify keeps the assertions on the exact wording and
    // keeps snackbar overlays out of the jsdom document.
    const notify = TestBed.inject(Notify);
    success = vi.spyOn(notify, 'success').mockImplementation(() => {});
    error = vi.spyOn(notify, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    restoreApi();
  });

  async function render() {
    const fixture = TestBed.createComponent(ImportsPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  type Fixture = Awaited<ReturnType<typeof render>>;

  function host(fixture: Fixture): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function textOf(fixture: Fixture): string {
    return host(fixture).textContent!.replace(/\s+/g, ' ');
  }

  function tables(fixture: Fixture): HTMLTableElement[] {
    return Array.from(host(fixture).querySelectorAll('table[mat-table]'));
  }

  function cells(table: HTMLTableElement, rowSelector: string): string[][] {
    return Array.from(table.querySelectorAll(rowSelector), (row) =>
      Array.from(row.querySelectorAll('th,td'), (c) => c.textContent!.replace(/\s+/g, ' ').trim()),
    );
  }

  function snapshotRows(fixture: Fixture): string[][] {
    return cells(tables(fixture)[0], 'tr[mat-row]');
  }

  /** The snapshot table's row for `filename`. */
  function rowFor(fixture: Fixture, filename: string): HTMLTableRowElement {
    const row = Array.from(
      tables(fixture)[0].querySelectorAll<HTMLTableRowElement>('tr[mat-row]'),
    ).find((r) => r.querySelector('a')?.textContent?.trim() === filename);
    if (!row) throw new Error(`no snapshot row for ${filename}`);
    return row;
  }

  function iconButton(row: HTMLElement, label: string): HTMLButtonElement {
    const button = row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!button) throw new Error(`no "${label}" button`);
    return button;
  }

  function uploadButton(fixture: Fixture): HTMLButtonElement {
    const button = Array.from(host(fixture).querySelectorAll('button')).find((b) =>
      b.textContent!.includes('Upload snapshot'),
    );
    if (!button) throw new Error('no upload button');
    return button;
  }

  async function selectSnapshot(fixture: Fixture, filename: string): Promise<void> {
    rowFor(fixture, filename).querySelector('a')!.click();
    await settle(fixture);
  }

  /** Drives one link select: click its trigger, then pick the option
   *  out of the panel that trigger owns — a document-wide mat-option
   *  query can pick up a panel that is still closing. */
  async function pickLink(fixture: Fixture, index: number, optionText: string): Promise<void> {
    const select = host(fixture).querySelectorAll<HTMLElement>('mat-select')[index];
    if (!select) throw new Error(`no link select at index ${index}`);
    select.querySelector<HTMLElement>('.mat-mdc-select-trigger')!.click();
    await settle(fixture);
    const panelId = select.getAttribute('aria-controls');
    const panel = (panelId && document.getElementById(panelId)) || null;
    const root = panel ?? document.querySelector<HTMLElement>('.mat-mdc-select-panel');
    if (!root) throw new Error('the select panel never opened');
    const options = Array.from(root.querySelectorAll<HTMLElement>('mat-option'));
    const option = options.find((o) => o.textContent!.trim() === optionText);
    if (!option) {
      throw new Error(
        `no option "${optionText}" among ${options.map((o) => o.textContent!.trim()).join(' | ')}`,
      );
    }
    option.click();
    await settle(fixture);
  }

  /** Fires the hidden picker's change event with a real File, the way
   *  the browser does once the user has chosen one. */
  async function chooseFile(fixture: Fixture, name: string, bytes: Uint8Array): Promise<void> {
    const input = host(fixture).querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([bytes as BlobPart], name, { type: 'application/octet-stream' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: { 0: file, length: 1, item: (i: number) => (i === 0 ? file : null) },
    });
    input.dispatchEvent(new Event('change'));
    await settle(fixture);
  }

  it('lists snapshots with status chips and trimmed timestamps', async () => {
    snapshots = [uploadedSnapshot(), failedSnapshot()];
    const fixture = await render();
    const rows = snapshotRows(fixture);
    expect(rows).toHaveLength(2);
    // file, as-of, uploaded, status, last processed, actions (icon text)
    expect(rows[0].slice(0, 5)).toEqual([
      'vanguard-sample.pb',
      '2026-08-18',
      '2026-08-18 10:15:32',
      'Uploaded',
      '',
    ]);
    expect(rows[1].slice(0, 5)).toEqual([
      'vanguard-prior.pb',
      '2026-08-01',
      '2026-08-01 08:00:00',
      'Failed',
      '2026-08-01 08:00:05',
    ]);
    const chips = host(fixture).querySelectorAll('.status-chip');
    expect(chips[0].classList.contains('failed')).toBe(false);
    expect(chips[0].classList.contains('processed')).toBe(false);
    expect(chips[1].classList.contains('failed')).toBe(true);
    expect(calls.listAccounts).toEqual([{ includeHidden: true }]);
    expect(textOf(fixture)).not.toContain('No snapshots yet');
  });

  it('shows the bankferry empty note and no accounts panel when nothing is archived', async () => {
    snapshots = [];
    const fixture = await render();
    expect(snapshotRows(fixture)).toHaveLength(0);
    expect(textOf(fixture)).toContain('No snapshots yet. Run bankferry investments export');
    expect(tables(fixture)).toHaveLength(1); // no accounts table
    expect(calls.accounts).toEqual([]);
  });

  it('loads a snapshot’s accounts only once its filename is clicked', async () => {
    const fixture = await render();
    expect(tables(fixture)).toHaveLength(1);
    expect(calls.accounts).toEqual([]);

    await selectSnapshot(fixture, 'vanguard-sample.pb');
    expect(calls.accounts).toEqual([10n]);
    expect(textOf(fixture)).toContain('Accounts in vanguard-sample.pb');
    const rows = cells(tables(fixture)[1], 'tr[mat-row]');
    expect(rows).toHaveLength(2);
    // The mask rides straight up against the name in the DOM; the gap
    // is CSS margin, not text.
    expect(rows[0].slice(0, 4)).toEqual(['Vanguard', 'Roth IRA…5678', 'investment / roth', '1']);
    // No mask and no subtype: neither decoration is rendered.
    expect(rows[1].slice(0, 4)).toEqual(['Vanguard', 'Brokerage', 'investment', '2']);
    expect(rowFor(fixture, 'vanguard-sample.pb').classList.contains('selected-row')).toBe(true);
  });

  it('shows each link select on its linked account, or the unlinked placeholder', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    // Two account selects, then the unmatched trust fund's.
    const selects = Array.from(host(fixture).querySelectorAll<HTMLElement>('mat-select'));
    expect(selects).toHaveLength(3);
    // linked_account_id 2 resolves against listAccounts, not the row's
    // linked_account_name, so the label is the select's option text.
    expect(selects[0].textContent!.trim()).toBe('Vanguard : Roth IRA (USD)');
    expect(selects[1].textContent!.trim()).toBe('Not linked');
  });

  it('links an unlinked Plaid account through the select and reloads the panel', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    await pickLink(fixture, 1, 'Vanguard : Brokerage (USD)');
    expect(calls.links).toEqual([{ accountRef: 'ref-brokerage', accountId: 1n }]);
    expect(success).toHaveBeenCalledWith('Account linked — process to import');
    expect(calls.accounts).toEqual([10n, 10n]); // panel refetched after linking
    expect(calls.list).toBe(1); // the snapshot list is not re-read
  });

  it('unlinking sends the bigint-zero sentinel and reports the link removed', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    await pickLink(fixture, 0, 'Not linked');
    expect(calls.links).toEqual([{ accountRef: 'ref-roth', accountId: 0n }]);
    expect(success).toHaveBeenCalledWith('Link removed');
  });

  it('routes a failed link to the error snackbar', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    onLink = () => {
      throw new ConnectError('no account 1', Code.NotFound);
    };
    await pickLink(fixture, 1, 'Vanguard : Brokerage (USD)');
    expect(success).not.toHaveBeenCalled();
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no account 1');
  });

  it('lists the snapshot’s securities: ticker matches as chips, no-ticker ones with a link select', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    expect(calls.securities).toEqual([10n]);
    expect(textOf(fixture)).toContain('Securities in vanguard-sample.pb');
    const rows = cells(tables(fixture)[2], 'tr[mat-row]');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual([
      'Vanguard Total Stock Market ETF',
      'VTI · CUSIP 922908769',
      'etf',
      '2',
      'VTI (by ticker)',
    ]);
    expect(rows[1].slice(0, 4)).toEqual(['Inst Tot Bd Mkt Ix Tr', 'no ticker', 'mutual fund', '1']);
    expect(rows[1][4]).toBe('Not linked');
    expect(tables(fixture)[2].querySelectorAll('mat-select')).toHaveLength(1);
  });

  it('links a no-ticker security to a finance2 security and refetches only that panel', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    await pickLink(fixture, 2, 'BONDX — Aggregate Bond Fund');
    expect(calls.securityLinks).toEqual([{ plaidSecurityId: 'plaid-sec-trust', securityId: 2n }]);
    expect(success).toHaveBeenCalledWith('Security linked — process to import');
    expect(calls.securities).toEqual([10n, 10n]);
    expect(calls.accounts).toEqual([10n]); // accounts panel untouched
  });

  it('shows a linked security on its select and unlinks with the zero sentinel', async () => {
    securityViews = [
      { ...plaidSecurities()[1], match: SecurityMatch.BY_LINK, securityId: 2n, securityTicker: 'BONDX' },
    ];
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    const select = tables(fixture)[2].querySelector<HTMLElement>('mat-select')!;
    expect(select.textContent!.trim()).toBe('BONDX — Aggregate Bond Fund');
    await pickLink(fixture, 2, 'Not linked');
    expect(calls.securityLinks).toEqual([{ plaidSecurityId: 'plaid-sec-trust', securityId: 0n }]);
    expect(success).toHaveBeenCalledWith('Link removed');
  });

  it('routes a failed security link to the error snackbar', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    onSecurityLink = () => {
      throw new ConnectError('no security 2', Code.NotFound);
    };
    await pickLink(fixture, 2, 'BONDX — Aggregate Bond Fund');
    expect(success).not.toHaveBeenCalled();
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no security 2');
  });

  it('mentions recorded prices in the process toast and report header only when there were any', async () => {
    onProcess = (id) => {
      const row = processedSnapshot();
      row.report!.pricesRecorded = 3;
      snapshots = snapshots.map((s) => (s.snapshotId === id ? row : s));
      return row;
    };
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').click();
    await settle(fixture);
    expect(success).toHaveBeenCalledWith(
      'Processed — 1 holding(s), 1 sweep(s) updated, 3 price(s) recorded',
    );
    expect(textOf(fixture)).toContain(
      'Last processing report (1 holding(s), 1 sweep(s) updated, 3 price(s) recorded)',
    );
  });

  it('processes a snapshot, reports the counts, and re-reads the list', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    const listsBefore = calls.list;
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').click();
    await settle(fixture);

    expect(calls.processed).toEqual([10n]);
    expect(success).toHaveBeenCalledWith('Processed — 1 holding(s), 1 sweep(s) updated');
    expect(calls.list).toBe(listsBefore + 1);
    const [row] = snapshotRows(fixture);
    expect(row[3]).toBe('Processed');
    expect(row[4]).toBe('2026-08-19 09:00:00');
    expect(host(fixture).querySelector('.status-chip')!.classList.contains('processed')).toBe(true);
    // Selection survives the reload, so the accounts panel stays open.
    expect(textOf(fixture)).toContain('Accounts in vanguard-sample.pb');
  });

  it('renders the report with counts, severity icons, and warning styling', async () => {
    snapshots = [processedSnapshot()];
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    expect(textOf(fixture)).toContain('Last processing report (1 holding(s), 1 sweep(s) updated)');
    const lines = Array.from(host(fixture).querySelectorAll<HTMLLIElement>('ul.report li'));
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toContain('sweep set to $55.25');
    expect(lines[0].querySelector('mat-icon')!.textContent!.trim()).toBe('info');
    expect(lines[0].classList.contains('warning')).toBe(false);
    expect(lines[1].textContent).toContain('GOLD is held here but absent from the');
    expect(lines[1].querySelector('mat-icon')!.textContent!.trim()).toBe('warning');
    expect(lines[1].classList.contains('warning')).toBe(true);
  });

  it('shows no report section for a snapshot that has never been processed', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    expect(textOf(fixture)).not.toContain('Last processing report');
    expect(host(fixture).querySelectorAll('ul.report')).toHaveLength(0);
  });

  it('routes a failed process to the error snackbar and re-enables the buttons', async () => {
    const fixture = await render();
    onProcess = () => {
      throw new ConnectError('no snapshot 10', Code.NotFound);
    };
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').click();
    await settle(fixture);
    expect(success).not.toHaveBeenCalled();
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no snapshot 10');
    expect(iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').disabled).toBe(false);
    expect(uploadButton(fixture).disabled).toBe(false);
  });

  it('disables Upload and Process while a run is in flight', async () => {
    const fixture = await render();
    let release!: (row: SnapshotRow) => void;
    onProcess = () => new Promise<SnapshotRow>((resolve) => (release = resolve));
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').click();
    await settle(fixture);

    expect(uploadButton(fixture).disabled).toBe(true);
    expect(iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').disabled).toBe(true);

    release(processedSnapshot());
    await settle(fixture);
    expect(uploadButton(fixture).disabled).toBe(false);
    expect(iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Process snapshot').disabled).toBe(false);
  });

  it('uploads the chosen file’s bytes, then selects the new snapshot', async () => {
    const fixture = await render();
    const bytes = new Uint8Array([8, 1, 18, 6, 8, 234, 15, 16, 8, 24, 18]);
    await chooseFile(fixture, 'today.pb', bytes);

    expect(calls.uploads).toHaveLength(1);
    expect(calls.uploads[0].filename).toBe('today.pb');
    expect(Array.from(calls.uploads[0].content)).toEqual(Array.from(bytes));
    expect(success).toHaveBeenCalledWith('today.pb archived — link accounts, then process');
    // Newest first; the response's id becomes the selection.
    expect(snapshotRows(fixture).map((r) => r[0])).toEqual(['today.pb', 'vanguard-sample.pb']);
    expect(calls.accounts).toEqual([11n]);
    expect(textOf(fixture)).toContain('Accounts in today.pb');
    // The picker is cleared so the same file can be chosen again.
    expect(host(fixture).querySelector<HTMLInputElement>('input[type="file"]')!.value).toBe('');
  });

  it('routes a rejected upload to the error snackbar and archives nothing', async () => {
    const fixture = await render();
    onUpload = () => {
      throw new ConnectError('the file is not a bankferry investments snapshot', Code.InvalidArgument);
    };
    await chooseFile(fixture, 'notes.txt', new Uint8Array([1, 2, 3]));
    expect(success).not.toHaveBeenCalled();
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe(
      'the file is not a bankferry investments snapshot',
    );
    expect(snapshotRows(fixture).map((r) => r[0])).toEqual(['vanguard-sample.pb']);
    expect(uploadButton(fixture).disabled).toBe(false);
  });

  it('confirms before deleting, then drops the row and clears the selection', async () => {
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Delete snapshot').click();
    await settle(fixture);

    expect(confirm).toHaveBeenCalledWith('Delete vanguard-sample.pb (uploaded 2026-08-18 10:15:32)?');
    expect(calls.deleted).toEqual([10n]);
    expect(success).toHaveBeenCalledWith('Snapshot deleted');
    expect(textOf(fixture)).not.toContain('Accounts in vanguard-sample.pb');
    expect(textOf(fixture)).toContain('No snapshots yet.');
  });

  it('cancelling the delete confirm calls nothing', async () => {
    const fixture = await render();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    iconButton(rowFor(fixture, 'vanguard-sample.pb'), 'Delete snapshot').click();
    await settle(fixture);
    expect(calls.deleted).toEqual([]);
    expect(success).not.toHaveBeenCalled();
    expect(snapshotRows(fixture)).toHaveLength(1);
  });

  it('deleting a different snapshot keeps the current selection', async () => {
    snapshots = [uploadedSnapshot(), failedSnapshot()];
    const fixture = await render();
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    iconButton(rowFor(fixture, 'vanguard-prior.pb'), 'Delete snapshot').click();
    await settle(fixture);
    expect(calls.deleted).toEqual([9n]);
    expect(snapshotRows(fixture).map((r) => r[0])).toEqual(['vanguard-sample.pb']);
    expect(textOf(fixture)).toContain('Accounts in vanguard-sample.pb');
  });

  it('routes a failed initial load to the error snackbar and renders the empty state', async () => {
    onList = () => {
      throw new ConnectError('boom', Code.Unavailable);
    };
    const fixture = await render();
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('boom');
    expect(snapshotRows(fixture)).toHaveLength(0);
    expect(textOf(fixture)).toContain('No snapshots yet.');
  });

  it('keeps the panel open when the accounts RPC fails', async () => {
    const fixture = await render();
    onGetAccounts = () => {
      throw new ConnectError('no snapshot 10', Code.NotFound);
    };
    await selectSnapshot(fixture, 'vanguard-sample.pb');
    expect((error.mock.calls[0][0] as ConnectError).rawMessage).toBe('no snapshot 10');
    // BUG (pinning current behavior): the snapshot stays selected and the
    // accounts table renders with no rows and no explanatory text — the
    // only signal that the panel is empty by failure rather than by fact
    // is the transient error snackbar.
    expect(textOf(fixture)).toContain('Accounts in vanguard-sample.pb');
    expect(cells(tables(fixture)[1], 'tr[mat-row]')).toHaveLength(0);
  });

  it('formats timestamps, status labels, and account labels defensively', () => {
    const page = TestBed.createComponent(ImportsPage).componentInstance;
    expect(page.timestamp('')).toBe('');
    expect(page.timestamp('2026-08-18T10:15:32.123456-04:00')).toBe('2026-08-18 10:15:32');
    expect(page.timestamp('2026-08-18T10:15:32Z')).toBe('2026-08-18 10:15:32');
    expect(page.statusLabel(uploadedSnapshot())).toBe('Uploaded');
    expect(page.statusLabel(processedSnapshot())).toBe('Processed');
    expect(page.statusLabel(failedSnapshot())).toBe('Failed');
    expect(page.statusLabel(create(SnapshotRowSchema, {}))).toBe('');
    expect(page.severityIcon(ReportSeverity.WARNING)).toBe('warning');
    expect(page.severityIcon(ReportSeverity.INFO)).toBe('info');
    expect(page.accountLabel(sampleAccounts()[1])).toBe('Vanguard : Roth IRA (USD)');
    expect(page.UNLINKED).toBe(0n);
  });
});
