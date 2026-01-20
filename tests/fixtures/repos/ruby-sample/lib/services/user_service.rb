# frozen_string_literal: true

require_relative '../models/user'
require_relative '../models/role'
require_relative '../errors'

# Service layer for user operations
module Services
  class UserService
    def initialize(user_repository:, role_repository:, id_generator: nil)
      @user_repository = user_repository
      @role_repository = role_repository
      @id_generator = id_generator || -> { SecureRandom.uuid }
    end

    def create_user(email:, name:, role_id:)
      validate_email!(email)
      ensure_unique_email!(email)

      role = find_role!(role_id)

      user = Models::User.new(
        id: @id_generator.call,
        email: email,
        name: name,
        role: role
      )

      @user_repository.save(user)
      user
    end

    def find_user(id)
      user = @user_repository.find(id)
      raise Errors::NotFoundError.new('User', id) unless user

      user
    end

    def find_user_by_email(email)
      user = @user_repository.find_by_email(email)
      raise Errors::NotFoundError.new('User', email) unless user

      user
    end

    def update_user(id, attributes)
      user = find_user(id)

      if attributes[:email] && attributes[:email] != user.email
        validate_email!(attributes[:email])
        ensure_unique_email!(attributes[:email])
      end

      if attributes[:role_id]
        attributes[:role] = find_role!(attributes.delete(:role_id))
      end

      user.update(attributes)
      @user_repository.save(user)
      user
    end

    def delete_user(id)
      user = find_user(id)
      @user_repository.delete(user.id)
    end

    def list_users(page: 1, per_page: 20)
      @user_repository.all(page: page, per_page: per_page)
    end

    def change_role(user_id, role_id)
      user = find_user(user_id)
      role = find_role!(role_id)

      user.update(role: role)
      @user_repository.save(user)
      user
    end

    private

    EMAIL_REGEX = /\A[\w+\-.]+@[a-z\d\-]+(\.[a-z\d\-]+)*\.[a-z]+\z/i

    def validate_email!(email)
      return if email&.match?(EMAIL_REGEX)

      raise Errors::ValidationError, 'Invalid email format'
    end

    def ensure_unique_email!(email)
      existing = @user_repository.find_by_email(email)
      return unless existing

      raise Errors::ValidationError, 'Email already registered'
    end

    def find_role!(role_id)
      role = @role_repository.find(role_id)
      raise Errors::NotFoundError.new('Role', role_id) unless role

      role
    end
  end
end
