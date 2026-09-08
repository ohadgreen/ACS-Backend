import { Injectable } from '@nestjs/common';
import { MaintenanceRepository } from './maintenance.repository';

@Injectable()
export class MaintenanceService {
  constructor(private readonly repo: MaintenanceRepository) {}

  /** `now` is injectable so the scheduler in sub-project #3 can pin it. */
  sweepExpired(now = new Date()) {
    return this.repo.sweepExpired(now);
  }
}
