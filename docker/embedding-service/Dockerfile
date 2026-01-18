FROM python:3.11-slim

WORKDIR /app

# Install fastembed
RUN pip install --no-cache-dir fastembed flask gunicorn

# Copy service code
COPY server.py .

# Expose port
EXPOSE 8080

# Run with gunicorn for production
CMD ["gunicorn", "--bind", "0.0.0.0:8080", "--workers", "1", "--threads", "4", "server:app"]
