import { startApplication } from './lifecycle';
import { logger } from './logger';

startApplication().catch((err) => {
  logger.fatal({ err }, 'Fatal startup failure');
  process.exit(1);
});
