export const logger = {
  info(message: string, context?: any) {
    const timestamp = new Date().toISOString();
    console.log(`\x1b[36m[${timestamp}] [INFO]\x1b[0m ${message}`, context ? JSON.stringify(context, null, 2) : '');
  },

  warn(message: string, context?: any) {
    const timestamp = new Date().toISOString();
    console.warn(`\x1b[33m[${timestamp}] [WARN]\x1b[0m ${message}`, context ? JSON.stringify(context, null, 2) : '');
  },

  error(message: string, error?: any) {
    const timestamp = new Date().toISOString();
    console.error(`\x1b[31m[${timestamp}] [ERROR]\x1b[0m ${message}`, error || '');
  },

  debug(message: string, context?: any) {
    if (process.env.NODE_ENV !== 'production') {
      const timestamp = new Date().toISOString();
      console.log(`\x1b[35m[${timestamp}] [DEBUG]\x1b[0m ${message}`, context ? JSON.stringify(context, null, 2) : '');
    }
  }
};
