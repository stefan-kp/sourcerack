/**
 * Repository group management commands
 *
 * Commands for managing repository groups:
 * - group list: List all groups
 * - group show <name>: Show details of a group
 * - group add <name> --repos <repos>: Create/update a group
 * - group remove <name>: Remove a group
 * - group default [name]: Set or show default group
 */

import { Command } from 'commander';
import chalk from 'chalk';
import {
  listGroups,
  getGroup,
  addGroup,
  removeGroup,
  setDefaultGroup,
  getDefaultGroup,
  groupExists,
} from '../../config/groups.js';
import { InvalidArgumentError, handleError } from '../errors.js';

/**
 * Create the group command
 */
export function createGroupCommand(): Command {
  const group = new Command('group')
    .description('Manage repository groups')
    .addHelpText('after', `
Examples:
  sourcerack group list                     List all groups
  sourcerack group show work                Show details of 'work' group
  sourcerack group add work --repos a,b,c   Create group with repos
  sourcerack group add work --repos d       Add repo to existing group
  sourcerack group remove work              Remove a group
  sourcerack group default work             Set default group
  sourcerack group default                  Show current default group
`);

  // List all groups
  group
    .command('list')
    .alias('ls')
    .description('List all repository groups')
    .action(() => {
      try {
        const groups = listGroups();
        const defaultGroup = getDefaultGroup();

        if (groups.length === 0) {
          console.log(chalk.yellow('No groups defined.'));
          console.log('');
          console.log('Create a group with:');
          console.log(chalk.cyan('  sourcerack group add <name> --repos <repo1,repo2,...>'));
          return;
        }

        console.log(chalk.bold('Repository Groups:\n'));

        for (const g of groups) {
          const isDefault = g.name === defaultGroup;
          const nameDisplay = isDefault
            ? chalk.green(`${g.name} (default)`)
            : chalk.cyan(g.name);

          console.log(`${nameDisplay}`);
          if (g.description) {
            console.log(`  ${chalk.dim(g.description)}`);
          }
          console.log(`  ${chalk.dim('Repos:')} ${g.repos.length}`);
          for (const repo of g.repos) {
            console.log(`    - ${repo}`);
          }
          console.log('');
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Show group details
  group
    .command('show <name>')
    .description('Show details of a repository group')
    .action((name: string) => {
      try {
        const g = getGroup(name);
        const defaultGroup = getDefaultGroup();

        if (!g) {
          throw new InvalidArgumentError(`Group not found: "${name}"`);
        }

        const isDefault = g.name === defaultGroup;
        console.log(chalk.bold(`Group: ${g.name}`) + (isDefault ? chalk.green(' (default)') : ''));
        console.log('');

        if (g.description) {
          console.log(chalk.dim('Description:'));
          console.log(`  ${g.description}`);
          console.log('');
        }

        console.log(chalk.dim(`Repositories (${g.repos.length}):`));
        for (const repo of g.repos) {
          console.log(`  - ${repo}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Add/create group
  group
    .command('add <name>')
    .description('Create a new group or add repos to existing group')
    .requiredOption('--repos <repos>', 'Comma-separated list of repository names or paths')
    .option('--description <desc>', 'Group description')
    .option('--replace', 'Replace existing group instead of merging')
    .action((name: string, options: { repos: string; description?: string; replace?: boolean }) => {
      try {
        const repos = options.repos.split(',').map((r) => r.trim()).filter(Boolean);

        if (repos.length === 0) {
          throw new InvalidArgumentError('At least one repository is required');
        }

        const existing = getGroup(name);

        if (existing && !options.replace) {
          // Merge with existing
          const mergedRepos = new Set([...existing.repos, ...repos]);
          addGroup(name, Array.from(mergedRepos), options.description ?? existing.description);
          console.log(chalk.green(`✓ Added ${repos.length} repo(s) to group "${name}"`));
          console.log(`  Total repos in group: ${mergedRepos.size}`);
        } else {
          // Create new or replace
          addGroup(name, repos, options.description);
          if (existing) {
            console.log(chalk.green(`✓ Replaced group "${name}" with ${repos.length} repo(s)`));
          } else {
            console.log(chalk.green(`✓ Created group "${name}" with ${repos.length} repo(s)`));
          }
        }
      } catch (error) {
        handleError(error);
      }
    });

  // Remove group
  group
    .command('remove <name>')
    .alias('rm')
    .description('Remove a repository group')
    .action((name: string) => {
      try {
        if (!groupExists(name)) {
          throw new InvalidArgumentError(`Group not found: "${name}"`);
        }

        removeGroup(name);
        console.log(chalk.green(`✓ Removed group "${name}"`));
      } catch (error) {
        handleError(error);
      }
    });

  // Set/show default group
  group
    .command('default [name]')
    .description('Set or show the default group')
    .option('--clear', 'Clear the default group')
    .action((name: string | undefined, options: { clear?: boolean }) => {
      try {
        if (options.clear) {
          setDefaultGroup(null);
          console.log(chalk.green('✓ Cleared default group'));
          return;
        }

        if (name === undefined) {
          // Show current default
          const defaultGroup = getDefaultGroup();
          if (defaultGroup) {
            console.log(`Default group: ${chalk.cyan(defaultGroup)}`);
          } else {
            console.log(chalk.yellow('No default group set'));
          }
          return;
        }

        if (!groupExists(name)) {
          throw new InvalidArgumentError(`Group not found: "${name}"`);
        }

        setDefaultGroup(name);
        console.log(chalk.green(`✓ Set default group to "${name}"`));
      } catch (error) {
        handleError(error);
      }
    });

  return group;
}
