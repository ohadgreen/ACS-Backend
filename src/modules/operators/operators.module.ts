import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AdminOperatorsController } from './admin-operators.controller';
import { OperatorsController } from './operators.controller';
import { OperatorsRepository } from './operators.repository';
import { OperatorsService } from './operators.service';

@Module({
  imports: [AuthModule, UsersModule],
  controllers: [AdminOperatorsController, OperatorsController],
  providers: [OperatorsRepository, OperatorsService],
  exports: [OperatorsRepository, OperatorsService],
})
export class OperatorsModule {}
