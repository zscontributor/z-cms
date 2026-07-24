import { Module } from "@nestjs/common";
import { ContentsController } from "./contents.controller";
import { ContentsService } from "./contents.service";

@Module({
  controllers: [ContentsController],
  providers: [ContentsService],
  exports: [ContentsService],
})
export class ContentsModule {}
