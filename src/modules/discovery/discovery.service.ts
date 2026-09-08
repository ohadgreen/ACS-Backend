import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { businessDayBounds } from '../../common/time/business-day';
import { requireEnv, type AppConfig } from '../../infra/config/typed-config';
import { LocationsRepository } from '../locations/locations.repository';
import { LocationsService } from '../locations/locations.service';
import { DiscoveryRepository } from './discovery.repository';

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly repo: DiscoveryRepository,
    private readonly locationsRepo: LocationsRepository,
    private readonly locations: LocationsService,
    @Inject(ConfigService) private readonly config: AppConfig,
  ) {}

  /**
   * Nothing starting sooner than BOOKING_LEAD_TIME_MIN is offered — a session
   * beginning in forty seconds is not bookable in practice. The upper bound is
   * the end of today in the business timezone: this is an on-demand product,
   * not a calendar.
   */
  private todayWindow() {
    const timeZone = requireEnv(this.config, 'BUSINESS_TIMEZONE');
    const leadMin = requireEnv(this.config, 'BOOKING_LEAD_TIME_MIN');
    const { start, end } = businessDayBounds(new Date(), timeZone);
    const earliest = new Date(Date.now() + leadMin * 60_000);
    return { from: earliest > start ? earliest : start, to: end };
  }

  async nearby(lat: number, lng: number, radius?: number) {
    const radiusM = radius ?? requireEnv(this.config, 'DISCOVERY_RADIUS_M');
    const rows = await this.repo.nearbyLocations(lat, lng, radiusM);

    const { from, to } = this.todayWindow();
    const capacities = await this.repo.slotCapacities(
      rows.map((r) => r.id),
      from,
      to,
    );

    const byLocation = new Map<string, Array<{ startAt: string; capacity: number }>>();
    for (const c of capacities) {
      const list = byLocation.get(c.locationId) ?? [];
      list.push({ startAt: c.startAt.toISOString(), capacity: c.capacity });
      byLocation.set(c.locationId, list);
    }

    return {
      radiusM,
      // Localized fields go out whole. The client switches language without a
      // round trip, so the server must not pre-resolve a locale.
      locations: rows.map((r) => ({
        id: r.id,
        code: r.code,
        siteCode: r.site_code,
        siteName: r.site_name,
        name: r.name,
        description: r.description,
        distanceM: Number(r.distance_m),
        minPrice: r.min_price,
        currency: r.currency,
        slots: byLocation.get(r.id) ?? [],
      })),
    };
  }

  async detail(locationId: string) {
    const location = await this.locations.requireActive(locationId);
    const sessionTypes = await this.locationsRepo.listActiveSessionTypes(locationId);
    const { from, to } = this.todayWindow();
    const capacities = await this.repo.slotCapacities([locationId], from, to);

    return {
      ...location,
      sessionTypes: sessionTypes.map((t) => ({
        id: t.id,
        code: t.code,
        name: t.name,
        description: t.description,
        price: t.price,
        currency: t.currency,
        sortOrder: t.sortOrder,
      })),
      slots: capacities.map((c) => ({
        startAt: c.startAt.toISOString(),
        capacity: c.capacity,
      })),
    };
  }
}
