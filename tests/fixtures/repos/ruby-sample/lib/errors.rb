# frozen_string_literal: true

# Common error classes
module Errors
  class BaseError < StandardError
    attr_reader :code

    def initialize(message, code: nil)
      super(message)
      @code = code
    end
  end

  class ValidationError < BaseError
    def initialize(message)
      super(message, code: 'VALIDATION_ERROR')
    end
  end

  class NotFoundError < BaseError
    attr_reader :resource, :identifier

    def initialize(resource, identifier)
      @resource = resource
      @identifier = identifier
      super("#{resource} not found: #{identifier}", code: 'NOT_FOUND')
    end
  end

  class AuthorizationError < BaseError
    def initialize(message = 'Not authorized')
      super(message, code: 'UNAUTHORIZED')
    end
  end

  class ConflictError < BaseError
    def initialize(message)
      super(message, code: 'CONFLICT')
    end
  end
end
