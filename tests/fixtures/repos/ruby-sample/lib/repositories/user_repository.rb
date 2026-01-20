# frozen_string_literal: true

require_relative 'base_repository'

# Repository for User entities
module Repositories
  class UserRepository < BaseRepository
    def find_by_email(email)
      find_by(:email, email)
    end

    def find_by_role(role_name)
      @storage.values.select { |user| user.role&.name == role_name }
    end

    def admins
      find_by_role('admin')
    end

    def active_users
      @storage.values.select do |user|
        user.updated_at > Time.now - (30 * 24 * 60 * 60) # 30 days
      end
    end
  end
end
