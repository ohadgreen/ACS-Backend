import { Body, Controller, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Roles } from '../../common/auth/roles.decorator';
import { LocationsService } from './locations.service';
import { CreateLocationDto, UpdateLocationDto } from './dto/location.dto';
import { CreateSessionTypeDto, UpdateSessionTypeDto } from './dto/session-type.dto';

@Roles('admin')
@Controller('admin')
export class AdminLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post('locations')
  create(@Body() dto: CreateLocationDto) {
    return this.locations.create(dto);
  }

  @Patch('locations/:id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateLocationDto) {
    return this.locations.update(id, dto);
  }

  @Post('locations/:id/session-types')
  addSessionType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSessionTypeDto) {
    return this.locations.addSessionType(id, dto);
  }

  // Session types are patched by their own id, not nested under the location:
  // the id already identifies exactly one, and nesting invites a mismatched
  // pair that has to be validated for no gain.
  @Patch('session-types/:id')
  updateSessionType(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSessionTypeDto) {
    return this.locations.updateSessionType(id, dto);
  }
}
