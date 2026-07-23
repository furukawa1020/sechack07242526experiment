import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";

import { ORDER_CODES } from "../../shared/conditions.js";
import type { ExperimentConfig } from "../../shared/schemas.js";
import type { SessionController } from "../sessions/session-controller.js";

const SessionIdSchema = z.string().uuid();
const DisplayTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/u);
const EmptyBodySchema = z.object({}).strict();
const CreateSessionSchema = z
  .object({
    researchId: z.string().min(1).max(64),
    consentConfirmed: z.literal(true),
    orderCode: z.union([z.literal("auto"), z.enum(ORDER_CODES)]).optional(),
  })
  .strict();
const InflateSchema = z.object({ level: z.number().min(0).max(1).optional() }).strict();

type AsyncHandler = (request: Request, response: Response) => Promise<void>;

function asyncHandler(handler: AsyncHandler) {
  return (request: Request, response: Response, next: NextFunction): void => {
    void handler(request, response).catch(next);
  };
}

function sessionId(request: Request): string {
  return SessionIdSchema.parse(request.params.id);
}

function assertEmptyBody(request: Request): void {
  EmptyBodySchema.parse(request.body ?? {});
}

/**
 * Formal API surface. This intentionally has no test-hook argument and does
 * not import or define the mock-device injection schemas used by test mode.
 */
export function createProductionApiRouter(
  controller: SessionController,
  config: ExperimentConfig,
): Router {
  const router = Router();
  const withDeviceMode = <Status extends object>(
    status: Status,
  ): Status & { mode: ExperimentConfig["device"]["mode"] } => ({
    ...status,
    mode: config.device.mode,
  });
  const deviceResponse = <Status extends object>(status: Status, ack: unknown = null) => ({
    status: withDeviceMode(status),
    ack,
  });

  router.get("/operator/config", (_request, response) => {
    response.json({
      researchIdPattern: config.researchIdPattern,
      protocolVersion: config.protocolVersion,
      rehearsal: controller.isRehearsal,
    });
  });

  router.post(
    "/sessions",
    asyncHandler(async (request, response) => {
      const input = CreateSessionSchema.parse(request.body);
      const created = await controller.create({
        researchId: input.researchId,
        consentConfirmed: input.consentConfirmed,
        ...(input.orderCode === undefined ? {} : { orderCode: input.orderCode }),
      });
      response.status(201).json(created);
    }),
  );

  router.get(
    "/sessions/:id",
    asyncHandler(async (request, response) => {
      response.json({ snapshot: controller.getOperatorSnapshot(sessionId(request)) });
    }),
  );

  const snapshotAction = (
    route: string,
    action: (id: string) => Promise<unknown>,
  ): void => {
    router.post(
      `/sessions/:id/${route}`,
      asyncHandler(async (request, response) => {
        assertEmptyBody(request);
        const snapshot = await action(sessionId(request));
        response.json({ snapshot });
      }),
    );
  };

  snapshotAction("prepare", (id) => controller.prepare(id));
  snapshotAction("start", (id) => controller.start(id));
  snapshotAction("resume", (id) => controller.resume(id));
  snapshotAction("abort", (id) => controller.abort(id));
  snapshotAction("emergency-stop", (id) => controller.emergencyStop(id));
  snapshotAction("confirm-response-checkpoint", (id) => controller.confirmResponseCheckpoint(id));
  snapshotAction("confirm-staff-handoff", (id) => controller.confirmStaffHandoff(id));

  router.delete(
    "/sessions/:id",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      await controller.delete(sessionId(request));
      response.json({ deleted: true });
    }),
  );

  router.get(
    "/display/:token",
    asyncHandler(async (request, response) => {
      const token = DisplayTokenSchema.parse(request.params.token);
      response.setHeader("Cache-Control", "no-store");
      response.json({ snapshot: controller.getPublicSnapshot(token) });
    }),
  );

  router.get(
    "/exports/sessions.csv",
    asyncHandler(async (_request, response) => {
      const csv = await controller.exportCsv();
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Disposition", 'attachment; filename="sessions.csv"');
      response.type("text/csv; charset=utf-8").send(csv);
    }),
  );

  router.post(
    "/device/connect",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      response.json(deviceResponse(await controller.connectDevice()));
    }),
  );
  router.post(
    "/device/disconnect",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      response.json(deviceResponse(await controller.disconnectDevice()));
    }),
  );
  router.post(
    "/device/ping",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      response.json(deviceResponse(await controller.pingDevice()));
    }),
  );
  router.post(
    "/device/status",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      response.json(deviceResponse(await controller.getDeviceStatus()));
    }),
  );
  router.get(
    "/device/status",
    asyncHandler(async (_request, response) => {
      response.json(deviceResponse(await controller.getDeviceStatus()));
    }),
  );
  router.post(
    "/device/inflate",
    asyncHandler(async (request, response) => {
      const input = InflateSchema.parse(request.body ?? {});
      const result = await controller.testInflate(input.level ?? config.fixedState.pufferLevel);
      response.json(deviceResponse(result.status, result.ack));
    }),
  );
  router.post(
    "/device/deflate",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      const result = await controller.testDeflate();
      response.json(deviceResponse(result.status, result.ack));
    }),
  );
  router.post(
    "/device/stop",
    asyncHandler(async (request, response) => {
      assertEmptyBody(request);
      const result = await controller.stopDevice();
      response.json(deviceResponse(result.status, result.ack));
    }),
  );

  return router;
}
