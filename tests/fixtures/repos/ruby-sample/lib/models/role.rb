# frozen_string_literal: true

# Role model for user permissions
module Models
  class Role
    attr_reader :id, :name, :permissions

    def initialize(id:, name:, permissions: [])
      @id = id
      @name = name
      @permissions = permissions.freeze
    end

    def has_permission?(permission)
      permissions.include?(permission)
    end

    def add_permission(permission)
      self.class.new(
        id: id,
        name: name,
        permissions: permissions + [permission]
      )
    end

    def remove_permission(permission)
      self.class.new(
        id: id,
        name: name,
        permissions: permissions - [permission]
      )
    end

    def to_h
      {
        id: id,
        name: name,
        permissions: permissions
      }
    end

    def to_json(*args)
      to_h.to_json(*args)
    end

    class << self
      def admin
        new(
          id: 'admin-role',
          name: 'admin',
          permissions: %w[read write delete admin]
        )
      end

      def user
        new(
          id: 'user-role',
          name: 'user',
          permissions: %w[read write]
        )
      end

      def guest
        new(
          id: 'guest-role',
          name: 'guest',
          permissions: %w[read]
        )
      end
    end
  end
end
