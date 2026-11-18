import winston from 'winston';
const {
  combine,
  timestamp,
  colorize,
  printf,
  errors,
  json,
} = winston.format;

const logFormat = printf(({ level, message, timestamp, stack }) =>
  stack
    ? `${timestamp} [${level}]: ${message}\n${stack}`
    : `${timestamp} [${level}]: ${message}`
);

const productionFormat = combine(
  timestamp(),
  errors({ stack: true }),
  json(),
);

const developmentFormat = combine(
      colorize({ all: true }),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      errors({ stack: true }),
      logFormat
);

const logger = winston.createLogger({
  level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  defaultMeta: { service: 'restaurant-backend' },
  transports: [
    new winston.transports.Console({
      // Heroku captures stdout/stderr. JSON in production is searchable by
      // request/job/tenant metadata and avoids writes to the ephemeral disk.
      format: process.env.NODE_ENV === 'production'
        ? productionFormat
        : developmentFormat,
    }),
  ],
});

export default logger;
