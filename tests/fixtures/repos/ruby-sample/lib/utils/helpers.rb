# frozen_string_literal: true

require 'securerandom'
require 'json'

# Utility helper methods
module Utils
  module Helpers
    module_function

    # Generate a unique identifier
    def generate_id
      SecureRandom.uuid
    end

    # Deep symbolize keys in a hash
    def deep_symbolize_keys(hash)
      return hash unless hash.is_a?(Hash)

      hash.each_with_object({}) do |(key, value), result|
        new_key = key.respond_to?(:to_sym) ? key.to_sym : key
        result[new_key] = case value
                          when Hash then deep_symbolize_keys(value)
                          when Array then value.map { |v| deep_symbolize_keys(v) }
                          else value
                          end
      end
    end

    # Deep stringify keys in a hash
    def deep_stringify_keys(hash)
      return hash unless hash.is_a?(Hash)

      hash.each_with_object({}) do |(key, value), result|
        new_key = key.to_s
        result[new_key] = case value
                          when Hash then deep_stringify_keys(value)
                          when Array then value.map { |v| deep_stringify_keys(v) }
                          else value
                          end
      end
    end

    # Retry a block with exponential backoff
    def retry_with_backoff(max_retries: 3, base_delay: 0.1)
      attempt = 0
      begin
        yield
      rescue StandardError => e
        attempt += 1
        raise e if attempt > max_retries

        sleep(base_delay * (2**attempt))
        retry
      end
    end

    # Memoize a method result
    def memoize(key, &block)
      @memo ||= {}
      @memo[key] ||= block.call
    end

    # Clear memoization cache
    def clear_memoization
      @memo = {}
    end
  end
end
