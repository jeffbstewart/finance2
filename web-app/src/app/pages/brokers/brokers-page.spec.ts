// Exemplar unit spec (docs/design/ui-testing.md): fake backend via
// installFakeApi, chart facades stubbed, zoneless TestBed. Per-page
// test agents copy this shape.
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrokerService } from '../../../proto-gen/brokers_pb';
import { installFakeApi } from '../../../testing/fake-api';
import { settle } from '../../../testing/settle';
import { sampleBrokers } from '../../../testing/sample-data';
import { PieChartStub } from '../../../testing/chart-stubs';
import { PieChart } from '../../shared/charts/pie-chart';
import { BrokersPage } from './brokers-page';

describe('BrokersPage', () => {
  let restoreApi: () => void;
  let listRequests: { includeHidden: boolean }[];

  beforeEach(() => {
    listRequests = [];
    restoreApi = installFakeApi(({ service }) => {
      service(BrokerService, {
        listBrokers: (request) => {
          listRequests.push({ includeHidden: request.includeHidden });
          const brokers = request.includeHidden
            ? sampleBrokers()
            : sampleBrokers().filter((b) => !b.hidden);
          return {
            brokers,
            totalHoldings: { display: '$64,000.00' },
            totalSweeps: { display: '$845.25' },
          };
        },
      });
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    TestBed.overrideComponent(BrokersPage, {
      remove: { imports: [PieChart] },
      add: { imports: [PieChartStub] },
    });
  });

  afterEach(() => restoreApi());

  async function render() {
    const fixture = TestBed.createComponent(BrokersPage);
    fixture.detectChanges();
    await settle(fixture);
    return fixture;
  }

  it('renders visible brokers with footer totals', async () => {
    const fixture = await render();
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('Vanguard');
    expect(text).toContain('EuroBank');
    expect(text).not.toContain('Old Broker');
    expect(text).toContain('$64,000.00');
    expect(listRequests).toEqual([{ includeHidden: false }]);
  });

  it('show-hidden refetches and reveals the hidden broker', async () => {
    const fixture = await render();
    fixture.componentInstance.toggleHidden(true);
    await settle(fixture);
    const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('Old Broker');
    expect(text).toContain('(hidden)');
    expect(listRequests).toEqual([{ includeHidden: false }, { includeHidden: true }]);
  });

  it('hands the pie facade only visible brokers as slices', async () => {
    const fixture = await render();
    const stub = fixture.debugElement.query(
      (el) => el.componentInstance instanceof PieChartStub,
    );
    expect(stub).toBeTruthy();
    const slices = (stub!.componentInstance as PieChartStub).slices();
    expect(slices.map((s) => s.name)).toEqual(['Vanguard', 'EuroBank']);
    expect(slices[0].display).toBe('$52,000.00');
  });
});
