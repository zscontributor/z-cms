import { Global, Injectable, Module, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  QueueProducer,
  type FailedJobPage,
  type JobName,
  type JobPayloads,
} from "@zcmsorg/queue";

/**
 * The API's handle on the background queue.
 *
 * A thin wrapper so services enqueue jobs without each constructing their own
 * Redis connection, and so the connection is closed cleanly on shutdown.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly producer: QueueProducer;

  constructor(config: ConfigService) {
    this.producer = new QueueProducer(
      config.get<string>("REDIS_URL") ?? "redis://localhost:6379",
    );
  }

  enqueue<K extends JobName>(
    name: K,
    payload: JobPayloads[K],
    options?: { jobId?: string; delayMs?: number },
  ): Promise<void> {
    return this.producer.enqueue(name, payload, options);
  }

  /** Jobs that exhausted their retries — the dead-letter queue, with its size. */
  failedJobs(limit?: number): Promise<FailedJobPage> {
    return this.producer.failedJobs(limit);
  }

  retryJob(id: string): Promise<boolean> {
    return this.producer.retryJob(id);
  }

  discardJob(id: string): Promise<boolean> {
    return this.producer.discardJob(id);
  }

  async onModuleDestroy(): Promise<void> {
    await this.producer.close();
  }
}

@Global()
@Module({
  providers: [QueueService],
  exports: [QueueService],
})
export class QueueModule {}
