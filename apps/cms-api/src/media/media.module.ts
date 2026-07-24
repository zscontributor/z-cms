import { Module } from "@nestjs/common";
import { MediaFoldersService } from "./media-folders.service";
import { MediaController } from "./media.controller";
import { MediaService } from "./media.service";

@Module({
  controllers: [MediaController],
  providers: [MediaService, MediaFoldersService],
  exports: [MediaService],
})
export class MediaModule {}
