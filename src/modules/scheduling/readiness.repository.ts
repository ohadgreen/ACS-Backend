import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { DRIZZLE, type Db } from '../../infra/db/drizzle.module';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';

export interface DueForNotification {
  id: string;
  customerId: string;
}

@Injectable()
export class ReadinessRepository {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  /**
   * Claim and record in one statement: the UPDATE that reads
   * `start_notified_at IS NULL` is the same one that sets it, so two worker
   * replicas cannot both notify — the second finds no matching row.
   *
   * The lower bound on `start_at` is not redundant. After a worker outage the
   * scan would otherwise announce "your session starts now" for a session the
   * sweep expires seconds later in the same tick. It uses the same
   * SLOT_DURATION_MIN as the sweep's grace, so the two partition the timeline
   * with no gap and no overlap.
   */
  async claimDueForStartNotification(now: Date): Promise<DueForNotification[]> {
    const slotMinutes = requireEnv(this.config, 'SLOT_DURATION_MIN');

    const result = await this.db.execute<{ id: string; customer_id: string }>(sql`
      UPDATE bookings
         SET start_notified_at = ${now}, updated_at = ${now}
       WHERE status = 'confirmed'
         AND start_notified_at IS NULL
         AND start_at <= ${now}
         AND start_at > ${now}::timestamptz - make_interval(mins => ${slotMinutes})
      RETURNING id, customer_id
    `);

    return result.rows.map((row) => ({ id: row.id, customerId: row.customer_id }));
  }
}
