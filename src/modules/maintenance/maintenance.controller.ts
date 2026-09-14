import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator';
import { MaintenanceService } from './maintenance.service';

@ApiBearerAuth()
@Roles('admin')
@Controller('admin/maintenance')
export class MaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  // Admin-triggerable now; sub-project #3 schedules the same service method.
  @Post('sweep-expired')
  @HttpCode(200)
  sweep() {
    return this.maintenance.sweepExpired();
  }
}
