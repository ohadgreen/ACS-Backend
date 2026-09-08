import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { Public } from '../../common/auth/public.decorator';
import { DiscoveryService } from './discovery.service';
import { NearbyQueryDto } from './dto/discovery.dto';

@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  // Public so customers can browse before verifying a phone number; booking
  // still requires a verified account.
  @Public()
  @Get('locations')
  nearby(@Query() query: NearbyQueryDto) {
    return this.discovery.nearby(query.lat, query.lng, query.radius);
  }

  @Public()
  @Get('locations/:id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.discovery.detail(id);
  }
}
