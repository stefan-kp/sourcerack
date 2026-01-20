# frozen_string_literal: true

# User model representing a system user
module Models
  class User
    include Comparable

    attr_reader :id, :email, :name, :role, :created_at
    attr_accessor :updated_at

    def initialize(id:, email:, name:, role:)
      @id = id
      @email = email
      @name = name
      @role = role
      @created_at = Time.now
      @updated_at = @created_at
    end

    def <=>(other)
      return nil unless other.is_a?(User)

      id <=> other.id
    end

    def admin?
      role&.name == 'admin'
    end

    def has_permission?(permission)
      role&.permissions&.include?(permission) || false
    end

    def update(attributes)
      attributes.each do |key, value|
        case key
        when :name
          @name = value
        when :email
          @email = value
        when :role
          @role = value
        end
      end
      @updated_at = Time.now
      self
    end

    def to_h
      {
        id: id,
        email: email,
        name: name,
        role: role&.to_h,
        created_at: created_at,
        updated_at: updated_at
      }
    end

    def to_json(*args)
      to_h.to_json(*args)
    end
  end
end
