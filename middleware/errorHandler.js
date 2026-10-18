const errorHandler = (err, req, res, next) => {
  // Keep stack traces in server logs, but never send internal exception details to
  // production clients. Route handlers should set err.status for safe 4xx errors.
  if (process.env.NODE_ENV === 'development') {
    console.error(err.stack || err);
  } else {
    console.error('[API error]', {
      status: err.status || 500,
      method: req.method,
      path: req.originalUrl,
      message: err.message,
    });
  }

  const status = Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
    ? err.status
    : 500;
  const publicMessage = status >= 500 && process.env.NODE_ENV !== 'development'
    ? 'Internal server error'
    : (err.message || 'Internal Server Error');

  res.status(status).json({
    message: publicMessage,
    ...(process.env.NODE_ENV === 'development' ? { error: err } : {}),
  });
};

module.exports = errorHandler;
