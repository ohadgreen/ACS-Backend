import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../../common/auth/roles.decorator';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../auth/auth.types';
import { OperatorsService } from './operators.service';
import { CreateOperatorDto } from './dto/create-operator.dto';

@ApiBearerAuth()
@Roles('admin')
@Controller('admin/operators')
export class AdminOperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Post()
  create(@Body() dto: CreateOperatorDto, @CurrentUser() admin: AuthenticatedUser) {
    return this.operators.invite(dto, admin.userId);
  }

  @Get()
  list() {
    return this.operators.list();
  }

  @Post(':id/approve')
  @HttpCode(204)
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() admin: AuthenticatedUser) {
    await this.operators.approve(id, admin.userId);
  }

  @Post(':id/suspend')
  @HttpCode(204)
  async suspend(@Param('id', ParseUUIDPipe) id: string) {
    await this.operators.suspend(id);
  }
}
