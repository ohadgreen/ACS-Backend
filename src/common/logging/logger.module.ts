import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { uuidv7 } from 'uuidv7';

export const REQUEST_ID_HEADER = 'x-request-id';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        // The id is echoed back on the response and included in every error
        // envelope, so a screenshot from a customer maps to a log in one query.
        genReqId: (req, res) => {
          const incoming = req.headers[REQUEST_ID_HEADER];
          const id = typeof incoming === 'string' && incoming.length > 0 ? incoming : uuidv7();
          res.setHeader(REQUEST_ID_HEADER, id);
          return id;
        },
        // Credentials must never reach the log, however convenient that would be
        // when debugging an auth failure.
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.code',
            'req.body.phone',
            'req.body.refreshToken',
          ],
          remove: true,
        },
        transport:
          process.env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      },
    }),
  ],
  exports: [LoggerModule],
})
export class AppLoggerModule {}
