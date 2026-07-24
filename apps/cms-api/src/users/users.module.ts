import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

/**
 * Imports AuthModule for one reason: a change to what someone may do has to be
 * able to end what they are currently doing. Removing a user, demoting them or
 * changing a password all call RevocationService through AuthService, and there
 * must be exactly one of those — a second instance would deny-list sessions in
 * its own Redis connection and be right only by accident.
 */
@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
