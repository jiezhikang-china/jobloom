import type { AppConfig, BossJobItem } from '../types.js';
import { currentCommute, validCommuteOrigin } from './commute.js';

/** Workplace distance is computed locally, without opening map dialogs or route requests. */
export class JobCommuteService {
  public async enrich(job: BossJobItem, filter: AppConfig['filter']): Promise<void> {
    if (!validCommuteOrigin(filter.commute?.origin)) { delete job.commute; return; }
    job.commute = currentCommute(filter.commute.origin, job.workAddress);
  }
}
export const jobCommuteService = new JobCommuteService();
