import { Injectable } from '@nestjs/common';
import { LocationsRepository } from './locations.repository';
import { ConflictError, NotFoundError } from '../../common/errors/domain-error';
import { ErrorCodes } from '../../common/errors/error-codes';
import { isUniqueViolation } from '../../infra/db/pg-error';

@Injectable()
export class LocationsService {
  constructor(private readonly repo: LocationsRepository) {}

  async create(input: Parameters<LocationsRepository['create']>[0]) {
    try {
      return await this.repo.create(input);
    } catch (cause) {
      if (isUniqueViolation(cause, 'locations_code_unique')) {
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          'That location code already exists.',
          { field: 'code' },
        );
      }
      throw cause;
    }
  }

  async update(id: string, patch: Parameters<LocationsRepository['update']>[1]) {
    const updated = await this.repo.update(id, patch);
    if (!updated) throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'No such location.');
    return updated;
  }

  /**
   * Deactivation is a soft delete, so every read path that offers a location to
   * a customer must go through this rather than a bare findById.
   */
  async requireActive(id: string) {
    const location = await this.repo.findById(id);
    if (!location || !location.isActive) {
      throw new NotFoundError(ErrorCodes.LOCATION_NOT_FOUND, 'No such active location.');
    }
    return location;
  }

  async addSessionType(
    locationId: string,
    input: Parameters<LocationsRepository['addSessionType']>[1],
  ) {
    await this.requireActive(locationId);
    try {
      return await this.repo.addSessionType(locationId, input);
    } catch (cause) {
      if (isUniqueViolation(cause, 'location_session_types_location_code')) {
        throw new ConflictError(
          ErrorCodes.VALIDATION_FAILED,
          'That session type code already exists at this location.',
          { field: 'code' },
        );
      }
      throw cause;
    }
  }

  async updateSessionType(
    id: string,
    patch: Parameters<LocationsRepository['updateSessionType']>[1],
  ) {
    const updated = await this.repo.updateSessionType(id, patch);
    if (!updated) {
      throw new NotFoundError(ErrorCodes.SESSION_TYPE_NOT_FOUND, 'No such session type.');
    }
    return updated;
  }
}
