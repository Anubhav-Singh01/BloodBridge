export {};

declare global {
  namespace Express {
    interface Request {
      /** Correlation id for this request. Set by middlewares/requestId.ts. */
      requestId: string;
    }
  }
}
