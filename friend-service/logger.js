const winston = require("winston");
const LogstashTransport = require("winston-logstash/lib/winston-logstash-latest");

const LOGSTASH_HOST = process.env.LOGSTASH_HOST || "logstash";
const LOGSTASH_PORT = parseInt(process.env.LOGSTASH_PORT || "5044", 10);

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.Console(),
    new LogstashTransport({
      host: LOGSTASH_HOST,
      port: LOGSTASH_PORT,
      max_connect_retries: 5,      // or -1 for infinite retries
      timeout_connect_retries: 5000
    }),
  ],
});

logger.on("error", (err) => {
  console.error("Logstash transport error:", err);
});

logger.info(`Logger initialized → ${LOGSTASH_HOST}:${LOGSTASH_PORT}`);

module.exports = logger;
