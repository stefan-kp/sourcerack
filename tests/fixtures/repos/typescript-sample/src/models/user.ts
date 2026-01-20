/**
 * User model and related types
 */

export interface UserRole {
  id: string;
  name: string;
  permissions: string[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateUserInput {
  email: string;
  name: string;
  roleId: string;
}

export class UserModel {
  private users: Map<string, User> = new Map();

  constructor(private readonly idGenerator: () => string) {}

  create(input: CreateUserInput, role: UserRole): User {
    const now = new Date();
    const user: User = {
      id: this.idGenerator(),
      email: input.email,
      name: input.name,
      role,
      createdAt: now,
      updatedAt: now,
    };
    this.users.set(user.id, user);
    return user;
  }

  findById(id: string): User | undefined {
    return this.users.get(id);
  }

  findByEmail(email: string): User | undefined {
    for (const user of this.users.values()) {
      if (user.email === email) {
        return user;
      }
    }
    return undefined;
  }

  update(id: string, updates: Partial<Omit<User, 'id' | 'createdAt'>>): User | undefined {
    const user = this.users.get(id);
    if (!user) return undefined;

    const updated: User = {
      ...user,
      ...updates,
      updatedAt: new Date(),
    };
    this.users.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.users.delete(id);
  }

  list(): User[] {
    return Array.from(this.users.values());
  }
}
