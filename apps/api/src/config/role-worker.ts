// Imported first by the worker entrypoint: logs, metrics and traces read the process role while modules load
// (imports are hoisted, so assigning it inside bootstrap() would be too late for instrument.ts and the logger).
process.env.TALKIVIO_PROCESS = 'worker';

export {};
