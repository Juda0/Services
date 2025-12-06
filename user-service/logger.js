const os = require('os');
const { createLogger, transports, format } = require('winston');
const LogstashTransport = require('winston-logstash/lib/winston-logstash-latest');

const LOGSTASH_HOST = process.env.LOGSTASH_HOST || 'logstash';
const LOGSTASH_PORT = parseInt(process.env.LOGSTASH_PORT || '5044', 10);

const serviceName = process.env.SERVICE_NAME || 'unknown-service';
const instanceId = os.hostname();

const logger = createLogger({
  level: 'info',
  defaultMeta: {   // Add service and instance info to all logs
    service: serviceName,
    instance: instanceId,
  },
  format: format.combine(
    format.timestamp({ format: () => new Date().toISOString() }), // UTC
    format.json()
  ),
  transports: [
    new transports.Console(),
    new LogstashTransport({
      host: LOGSTASH_HOST,
      port: LOGSTASH_PORT,
      max_connect_retries: -1,
      timeout_connect_retries: 5000,
    }),
  ],
});

logger.on('error', (err) => {
  console.error('Logstash transport error:', err);
});

logger.info(`Logger initialized → ${LOGSTASH_HOST}:${LOGSTASH_PORT}`);

module.exports = logger;
