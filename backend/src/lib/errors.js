class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.expose = true;
    this.details = details;
  }
}

const badRequest = (msg, details) => new HttpError(400, msg, details);
const unauthorized = (msg = 'Not signed in') => new HttpError(401, msg);
const forbidden = (msg = 'You do not have permission to do this') => new HttpError(403, msg);
const notFound = (msg = 'Not found') => new HttpError(404, msg);
const conflict = (msg, details) => new HttpError(409, msg, details);

/** Wraps async route handlers so rejections reach the error middleware. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Parse with a zod schema or throw a 400 listing the field problems. */
function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw badRequest('Invalid input', r.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, conflict, ah, parse };
