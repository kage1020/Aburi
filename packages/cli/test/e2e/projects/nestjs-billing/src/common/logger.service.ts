import { Injectable } from "@nestjs/common"

@Injectable()
export class LoggerService {
  info(message: string): void {
    if (message.length === 0) {
      throw new Error("logger.info: refusing to log an empty message")
    }
    console.log(`[info] ${message}`)
  }

  warn(message: string): void {
    if (message.length === 0) {
      throw new Error("logger.warn: refusing to log an empty message")
    }
    console.warn(`[warn] ${message}`)
  }

  error(message: string, cause?: unknown): void {
    if (message.length === 0) {
      throw new Error("logger.error: refusing to log an empty message")
    }
    console.error(`[error] ${message}`, cause)
  }
}
