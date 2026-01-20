/**
 * User service for business logic
 */

import { User, UserModel, CreateUserInput, UserRole } from '../models/user.js';

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} not found: ${id}`);
    this.name = 'NotFoundError';
  }
}

export interface RoleRepository {
  findById(id: string): UserRole | undefined;
}

export class UserService {
  constructor(
    private readonly userModel: UserModel,
    private readonly roleRepository: RoleRepository
  ) {}

  async createUser(input: CreateUserInput): Promise<User> {
    // Validate email format
    if (!this.isValidEmail(input.email)) {
      throw new ValidationError('Invalid email format');
    }

    // Check for duplicate email
    const existing = this.userModel.findByEmail(input.email);
    if (existing) {
      throw new ValidationError('Email already registered');
    }

    // Validate role
    const role = this.roleRepository.findById(input.roleId);
    if (!role) {
      throw new NotFoundError('Role', input.roleId);
    }

    return this.userModel.create(input, role);
  }

  async getUser(id: string): Promise<User> {
    const user = this.userModel.findById(id);
    if (!user) {
      throw new NotFoundError('User', id);
    }
    return user;
  }

  async getUserByEmail(email: string): Promise<User> {
    const user = this.userModel.findByEmail(email);
    if (!user) {
      throw new NotFoundError('User', email);
    }
    return user;
  }

  async updateUser(id: string, updates: { name?: string; email?: string }): Promise<User> {
    const user = this.userModel.findById(id);
    if (!user) {
      throw new NotFoundError('User', id);
    }

    if (updates.email && updates.email !== user.email) {
      if (!this.isValidEmail(updates.email)) {
        throw new ValidationError('Invalid email format');
      }
      const existing = this.userModel.findByEmail(updates.email);
      if (existing) {
        throw new ValidationError('Email already registered');
      }
    }

    const updated = this.userModel.update(id, updates);
    if (!updated) {
      throw new NotFoundError('User', id);
    }
    return updated;
  }

  async deleteUser(id: string): Promise<void> {
    const deleted = this.userModel.delete(id);
    if (!deleted) {
      throw new NotFoundError('User', id);
    }
  }

  async listUsers(): Promise<User[]> {
    return this.userModel.list();
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }
}
