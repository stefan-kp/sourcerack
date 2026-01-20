# frozen_string_literal: true

# Base repository with common CRUD operations
module Repositories
  class BaseRepository
    def initialize
      @storage = {}
    end

    def find(id)
      @storage[id]
    end

    def save(entity)
      @storage[entity.id] = entity
      entity
    end

    def delete(id)
      @storage.delete(id)
    end

    def all(page: 1, per_page: 20)
      items = @storage.values
      offset = (page - 1) * per_page
      items[offset, per_page] || []
    end

    def count
      @storage.size
    end

    def exists?(id)
      @storage.key?(id)
    end

    def clear
      @storage.clear
    end

    protected

    def find_by(attribute, value)
      @storage.values.find { |entity| entity.public_send(attribute) == value }
    end

    def find_all_by(attribute, value)
      @storage.values.select { |entity| entity.public_send(attribute) == value }
    end
  end
end
