import { createLogger, format, transports } from 'winston';

const logger = createLogger({
    level: 'info',
    format: format.combine(
        format.timestamp({
            format: 'YYYY-MM-DD HH:mm:ss',
        }),
        format.errors({ stack: true }),
        format.splat(),
        format.json()
    ),
    defaultMeta: { service: 'tls' },
    transports: [
        new transports.File({ filename: './tls-error.log', level: 'error' }),
        new transports.File({ filename: './tls.log' })
    ]
});

export default logger;