import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { Body, Controller, Get, type INestApplication, Post } from '@nestjs/common';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import request from 'supertest';
import { AllExceptionsFilter } from '../../src/common/errors/exception.filter';
import { ZodValidationPipe } from '../../src/common/validation/zod-validation.pipe';
import { AppLoggerModule } from '../../src/common/logging/logger.module';
import { ConflictError } from '../../src/common/errors/domain-error';

class ProbeDto extends createZodDto(
  z.object({ price: z.number().min(0), name: z.string().min(1) }),
) {}

@Controller('probe')
class ProbeController {
  @Post('validate')
  validate(@Body() dto: ProbeDto) {
    return dto;
  }

  @Get('domain')
  domain(): never {
    throw new ConflictError('SLOT_UNAVAILABLE', 'That slot is no longer available.', {
      startAt: '2026-09-06T08:00:00.000Z',
    });
  }

  @Get('boom')
  boom(): never {
    throw new Error('internal detail password=hunter2');
  }
}

let app: INestApplication;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppLoggerModule],
    controllers: [ProbeController],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(new ZodValidationPipe());
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('error envelope', () => {
  it('returns the envelope shape and echoes the request id', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('x-request-id', 'test-req-42');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ requestId: 'test-req-42' });
    expect(res.body.error).toHaveProperty('code');
    expect(res.body.error).toHaveProperty('details');
  });

  it('generates a request id when the caller sends none', async () => {
    const res = await request(app.getHttpServer()).get('/does-not-exist').expect(404);
    expect(res.body.error.requestId).toEqual(expect.any(String));
    expect(res.body.error.requestId).not.toBe('unknown');
  });

  it('echoes the request id in a response header too', async () => {
    const res = await request(app.getHttpServer())
      .get('/does-not-exist')
      .set('x-request-id', 'hdr-1');
    expect(res.headers['x-request-id']).toBe('hdr-1');
  });

  it('renders a domain error with its code, details and status', async () => {
    const res = await request(app.getHttpServer()).get('/probe/domain').expect(409);
    expect(res.body.error).toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      details: { startAt: '2026-09-06T08:00:00.000Z' },
    });
  });

  it('returns 422 with structured issues for a validation failure', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/validate')
      .send({ price: -1 })
      .expect(422);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details.issues as Array<{ path: string }>).map((i) => i.path);
    expect(paths).toContain('price');
    expect(paths).toContain('name');
  });

  it('accepts a valid body through the pipe', async () => {
    const res = await request(app.getHttpServer())
      .post('/probe/validate')
      .send({ price: 10, name: 'ok' })
      .expect(201);
    expect(res.body).toEqual({ price: 10, name: 'ok' });
  });

  it('never leaks internals from an unexpected error', async () => {
    const res = await request(app.getHttpServer()).get('/probe/boom').expect(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});
