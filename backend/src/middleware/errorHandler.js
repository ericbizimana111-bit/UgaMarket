const logger = require('../utils/logger');
const env = require('../config/env');

class AppError extends Error {
  constructor(message, statusCode = 500, errors = null) {
    super(message);
    this.statusCode = statusCode;
    this.errors = errors;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

const errorHandler = (err, req, res, next) => {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal server error';
  let errors = err.errors || null;

  // Handle Prisma Known Request Errors
  if (err.code === 'P2002') {
    statusCode = 409;
    const target = err.meta?.target ? err.meta.target.join(', ') : 'field';
    message = `A record with this ${target} already exists`;
  } else if (err.code === 'P2025') {
    statusCode = 404;
    message = 'Requested resource not found';
  } else if (err.name === 'JsonWebTokenError') {
    statusCode = 401;
    message = 'Invalid authentication token';
  } else if (err.name === 'TokenExpiredError') {
    statusCode = 401;
    message = 'Authentication token has expired';
  }

  // Client errors (bad input, not signed in, not found) are routine: one
  // warning line. Server errors keep the full stack for diagnosis.
  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} - Status ${statusCode}: ${message}`, err.stack);
  } else {
    logger.warn(`${req.method} ${req.originalUrl} - Status ${statusCode}: ${message}`);
  }

  // Never leak internals (SQL, file paths, library messages) to clients in
  // production: unexpected server errors get a generic message.
  if (statusCode >= 500 && !err.isOperational && env.NODE_ENV === 'production') {
    message = 'Something went wrong on our side. Please try again shortly.';
    errors = null;
  }

  res.status(statusCode).json({
    success: false,
    message,
    ...(errors && { errors }),
    ...(env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = {
  AppError,
  errorHandler,
};
