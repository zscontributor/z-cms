import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { disconnectDb } from "@zcmsorg/database";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { DOCS_PATH, GLOBAL_PREFIX, setupSwagger } from "./openapi/swagger";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
  });

  // The rate limiter keys on the client IP, and behind a load balancer that IP
  // is in X-Forwarded-For, not the socket. Without trusting the proxy, Express
  // reports the balancer's address for everyone and the per-IP limit becomes a
  // per-cluster limit — trivially bypassed and prone to locking everyone out at
  // once. In production TRUST_PROXY should name the exact hop count, not `true`,
  // so a client cannot forge the header.
  app.set("trust proxy", process.env.TRUST_PROXY ?? "loopback");

  // Security headers for the API's own responses. The API serves JSON, so the
  // CSP here is strict — it never returns HTML that would execute anything — and
  // the browser-facing apps set their own richer policies (see their middleware).
  const apiHeaders = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // The API is called cross-origin by the two front ends; COEP/CORP would
    // block those legitimate reads. CORS (below) is the right control here.
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  // The one place this API does serve HTML that must execute: Swagger UI, whose
  // bundle and boot script would be blocked outright by `default-src 'none'`.
  // It gets its own policy rather than a hole in the global one — everything is
  // pinned to this origin, so the relaxation cannot be used to pull in code from
  // anywhere else, and no other route is loosened by a byte.
  const docsHeaders = helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Swagger UI inlines its initialiser and its styles.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        // "Try it out" calls this same origin.
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
  });

  const docsPrefix = `/${GLOBAL_PREFIX}/${DOCS_PATH}`;
  app.use((req: Request, res: Response, next: NextFunction) => {
    return req.path.startsWith(docsPrefix) ? docsHeaders(req, res, next) : apiHeaders(req, res, next);
  });

  app.setGlobalPrefix(GLOBAL_PREFIX);

  app.enableCors({
    origin: [
      process.env.ADMIN_WEB_URL ?? "http://localhost:3001",
      process.env.SITE_RUNTIME_URL ?? "http://localhost:3000",
    ],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Site-Id", "X-Internal-Token"],
  });

  app.enableShutdownHooks();

  // After the global prefix and CORS: the document describes the routes as they
  // are actually mounted, and the UI is served from the same origin it calls.
  setupSwagger(app);

  const port = Number(process.env.CMS_API_PORT ?? 4100);
  await app.listen(port);

  new Logger("Bootstrap").log(`cms-api listening on http://localhost:${port}/api/v1`);
}

// Close the Postgres pools cleanly so a restart does not leave connections
// pinned in the database until they time out.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void disconnectDb().finally(() => process.exit(0));
  });
}

void bootstrap();
