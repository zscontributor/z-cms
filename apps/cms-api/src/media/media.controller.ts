import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from "@nestjs/swagger";
import {
  BulkDeleteMediaSchema,
  BulkMoveMediaSchema,
  CreateMediaFolderSchema,
  UpdateMediaFolderSchema,
  UpdateMediaSchema,
  type BulkDeleteMediaInput,
  type BulkMoveMediaInput,
  type CreateMediaFolderInput,
  type MediaDto,
  type MediaFolderDto,
  type Paginated,
  type UpdateMediaFolderInput,
  type UpdateMediaInput,
} from "@zcmsorg/schemas";
import { Actor, RequirePermissions, SiteId, SiteScoped } from "../auth/decorators";
import type { RequestActor } from "../common/request-context";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import {
  ApiAuthed,
  ApiFileUpload,
  ApiNoContent,
  ApiNotFound,
  ApiPaginatedResponse,
  ApiSiteScoped,
  ApiZodBody,
  ApiZodResponse,
} from "../openapi/decorators";
import { MediaFoldersService } from "./media-folders.service";
import {
  ALLOWED_MIME,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  MEDIA_KINDS,
  MediaService,
  type FolderScope,
  type MediaKind,
} from "./media.service";

/** "root" and a uuid are both valid; anything else means "every folder". */
function folderScope(value: string | undefined): FolderScope {
  if (!value) return undefined;
  return value;
}

function mediaKind(value: string | undefined): MediaKind | undefined {
  return MEDIA_KINDS.includes(value as MediaKind) ? (value as MediaKind) : undefined;
}

@ApiTags("Media")
@ApiSiteScoped()
@Controller("media")
@SiteScoped()
export class MediaController {
  constructor(
    private readonly media: MediaService,
    private readonly folders: MediaFoldersService,
  ) {}

  @Get()
  @ApiOperation({
    summary: "List uploads",
    description:
      "Newest first. `folder` picks what is being browsed: a folder id, or `root` " +
      "for the files filed at the top level. Omit it — as a search should — and " +
      "the query reaches across every folder.",
  })
  @ApiAuthed("media:read")
  @ApiQuery({ name: "search", required: false, description: "Substring of the filename or alt text." })
  @ApiQuery({ name: "kind", required: false, enum: MEDIA_KINDS })
  @ApiQuery({
    name: "folder",
    required: false,
    description: 'A folder id, or "root". Omit for every folder.',
  })
  @ApiQuery({ name: "page", required: false, schema: { type: "integer", minimum: 1, default: 1 } })
  @ApiQuery({
    name: "perPage",
    required: false,
    description: "Clamped to 100.",
    schema: { type: "integer", minimum: 1, maximum: 100, default: 40 },
  })
  @ApiPaginatedResponse("MediaDto")
  @RequirePermissions("media:read")
  list(
    @SiteId() siteId: string,
    @Query("search") search?: string,
    @Query("kind") kind?: string,
    @Query("folder") folder?: string,
    @Query("page") page = "1",
    @Query("perPage") perPage = "40",
  ): Promise<Paginated<MediaDto>> {
    return this.media.list(siteId, {
      search: search?.trim() || undefined,
      kind: mediaKind(kind),
      folder: folderScope(folder),
      page: Math.max(1, Number(page) || 1),
      perPage: Math.min(100, Math.max(1, Number(perPage) || 40)),
    });
  }

  @Get("upload-limits")
  @ApiOperation({
    summary: "What may be uploaded",
    description:
      "The same numbers the upload endpoint enforces. Read them rather than " +
      "hard-coding a copy in the client, which would drift the day the cap moves.",
  })
  @ApiAuthed("media:read")
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["maxBytes", "allowedMimeTypes"],
      properties: {
        maxBytes: { type: "integer", example: MAX_UPLOAD_BYTES },
        allowedMimeTypes: { type: "array", items: { type: "string" }, example: [...ALLOWED_MIME] },
      },
    },
  })
  @RequirePermissions("media:read")
  limits() {
    return { maxBytes: MAX_UPLOAD_BYTES, allowedMimeTypes: [...ALLOWED_MIME] };
  }

  // Folder routes are declared before `:id`, so that "folders" is never read as
  // a media id by a route matcher that takes the first pattern that fits.

  @Get("folders")
  @ApiOperation({
    summary: "List folders",
    description:
      "The whole tree, flat, with per-folder counts. Folders are metadata: a file " +
      "keeps its URL wherever it is filed, so moving one is free.",
  })
  @ApiAuthed("media:read")
  @ApiZodResponse("MediaFolderDto", { isArray: true })
  @RequirePermissions("media:read")
  listFolders(@SiteId() siteId: string): Promise<MediaFolderDto[]> {
    return this.folders.list(siteId);
  }

  @Post("folders")
  @HttpCode(201)
  @ApiOperation({ summary: "Create a folder", description: "Sibling names must be unique." })
  @ApiAuthed("media:update")
  @ApiZodBody("CreateMediaFolderInput")
  @ApiZodResponse("MediaFolderDto", { status: 201, description: "Created." })
  @RequirePermissions("media:update")
  createFolder(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(CreateMediaFolderSchema)) body: CreateMediaFolderInput,
  ): Promise<MediaFolderDto> {
    return this.folders.create(actor, siteId, body);
  }

  @Patch("folders/:id")
  @ApiOperation({
    summary: "Rename or move a folder",
    description: "A folder cannot be moved into its own subtree.",
  })
  @ApiAuthed("media:update")
  @ApiZodBody("UpdateMediaFolderInput")
  @ApiZodResponse("MediaFolderDto")
  @ApiNotFound("No such folder on this site.")
  @RequirePermissions("media:update")
  updateFolder(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMediaFolderSchema)) body: UpdateMediaFolderInput,
  ): Promise<MediaFolderDto> {
    return this.folders.update(actor, siteId, id, body);
  }

  @Delete("folders/:id")
  @ApiOperation({
    summary: "Delete a folder",
    description:
      "Deletes the folder and its subfolders. The files inside are NOT deleted — " +
      "they move up to where the folder used to sit, because a live page may be " +
      "rendering them and a filing change must not take a site's images down. " +
      "Returns how many files were re-filed.",
  })
  @ApiAuthed("media:delete")
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["movedFiles"],
      properties: { movedFiles: { type: "integer", example: 3 } },
    },
  })
  @ApiNotFound("No such folder on this site.")
  @RequirePermissions("media:delete")
  removeFolder(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<{ movedFiles: number }> {
    return this.folders.remove(actor, siteId, id);
  }

  @Post("bulk-move")
  @HttpCode(200)
  @ApiOperation({
    summary: "Move several files into a folder",
    description:
      "Filing only: no file's URL changes, so nothing that embeds them breaks. " +
      "Ids that do not belong to this site are ignored — `moved` is how many " +
      "actually moved, which need not equal how many were asked for.",
  })
  @ApiAuthed("media:update")
  @ApiZodBody("BulkMoveMediaInput")
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["moved"],
      properties: { moved: { type: "integer", example: 7 } },
    },
  })
  @RequirePermissions("media:update")
  bulkMove(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(BulkMoveMediaSchema)) body: BulkMoveMediaInput,
  ): Promise<{ moved: number }> {
    return this.media.bulkMove(actor, siteId, body.ids, body.folderId);
  }

  @Post("bulk-delete")
  @HttpCode(200)
  @ApiOperation({
    summary: "Delete several files",
    description:
      "POST, not DELETE: the list of ids is a body, and a DELETE with a body is " +
      "not something every proxy forwards. Removes the library entries; the stored " +
      "objects are swept later, for the same reason a single delete leaves them.",
  })
  @ApiAuthed("media:delete")
  @ApiZodBody("BulkDeleteMediaInput")
  @ApiResponse({
    status: 200,
    schema: {
      type: "object",
      required: ["deleted"],
      properties: { deleted: { type: "integer", example: 7 } },
    },
  })
  @RequirePermissions("media:delete")
  bulkRemove(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Body(new ZodValidationPipe(BulkDeleteMediaSchema)) body: BulkDeleteMediaInput,
  ): Promise<{ deleted: number }> {
    return this.media.bulkRemove(actor, siteId, body.ids);
  }

  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: "Upload a file",
    description:
      `multipart/form-data, one part named \`file\`, at most ${MAX_UPLOAD_LABEL}. ` +
      "The MIME type must be on the allowlist — SVG is excluded on purpose, since " +
      "it can carry script that would run on the site's own origin. " +
      "Send `folderId` as a second part to file it straight into a folder. " +
      "Returns as soon as the original is stored; thumbnails are generated by a " +
      "worker moments later, so `width`/`height` may still be null in this response.",
  })
  @ApiAuthed("media:upload")
  @ApiFileUpload(`The file. Max ${MAX_UPLOAD_LABEL}; images and PDF only.`, {
    folderId: { type: "string", description: "Optional: file it into this folder." },
  })
  @ApiZodResponse("MediaDto", { status: 201, description: "Stored." })
  @RequirePermissions("media:upload")
  // Multer buffers into memory, which is fine at a 20MB cap; streaming straight
  // to S3 is the upgrade path when large video uploads arrive.
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  upload(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @UploadedFile() file: Express.Multer.File,
    @Body("folderId") folderId?: string,
  ): Promise<MediaDto> {
    return this.media.upload(actor, siteId, file, folderId || null);
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Rename, describe or move a file",
    description:
      "Partial: only the fields you send change. None of them touch storage — the " +
      "object key is minted at upload and is not derived from the filename — so a " +
      "rename or a move never changes the file's URL and cannot break a published " +
      "page. Send `alt: null` to clear the alt text; omit the key to leave it.",
  })
  @ApiAuthed("media:update")
  @ApiZodBody("UpdateMediaInput")
  @ApiZodResponse("MediaDto")
  @ApiNotFound("No such media on this site.")
  @RequirePermissions("media:update")
  update(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
    @Body(new ZodValidationPipe(UpdateMediaSchema)) body: UpdateMediaInput,
  ): Promise<MediaDto> {
    return this.media.update(actor, siteId, id, body);
  }

  @Delete(":id")
  @HttpCode(204)
  @ApiOperation({
    summary: "Delete an upload",
    description:
      "Removes the library entry. The stored object is swept later, because " +
      "content may still reference the URL and a broken image on a live page " +
      "costs more than an orphaned object does.",
  })
  @ApiAuthed("media:delete")
  @ApiNoContent("Deleted.")
  @ApiNotFound("No such media on this site.")
  @RequirePermissions("media:delete")
  async remove(
    @Actor() actor: RequestActor,
    @SiteId() siteId: string,
    @Param("id") id: string,
  ): Promise<void> {
    await this.media.remove(actor, siteId, id);
  }
}
