/**
 * PostgreSQL Server Management Utility
 *
 * Manages the lifecycle of the local PostgreSQL server for development and testing.
 * This module provides utilities to:
 * - Detect PostgreSQL data directory initialization
 * - Automatically setup if not initialized
 * - Start PostgreSQL server with error handling
 * - Stop PostgreSQL server gracefully
 */

import { execSync, spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../config/logger.js';

// Resolve repository root from apps/node-backend/src/database.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..', '..', '..', '..');

/**
 * PostgreSQL Manager for development and local deployments
 */
class PostgresManager {
    constructor(projectRootOverride) {
        this.projectRoot = projectRootOverride || projectRoot;
        this.postgresDataDir = join(this.projectRoot, 'postgres_data');
        this.postgresLogFile = join(this.postgresDataDir, 'postgres.log');
        this.port = 5433; // Use non-standard port to avoid conflicts
    }

    /**
     * Check if PostgreSQL data directory is initialized
     * @returns {boolean} True if postgres_data/base directory exists
     */
    isInitialized() {
        const baseDir = join(this.postgresDataDir, 'base');
        const initialized = existsSync(baseDir);
        logger.debug(`PostgreSQL initialization check: ${initialized}`, {
            operation: 'postgres_init_check',
            dataDir: this.postgresDataDir,
        });
        return initialized;
    }

    /**
     * Check if PostgreSQL server is currently running
     * @returns {boolean} True if server is running
     */
    isRunning() {
        try {
            execSync(`pg_ctl -D "${this.postgresDataDir}" status`, {
                stdio: 'pipe',
            });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Setup PostgreSQL: initialize data directory if needed
     * @returns {Promise<boolean>} True if setup succeeded
     */
    async setup() {
        if (this.isInitialized()) {
            logger.info('PostgreSQL data directory already initialized');
            return true;
        }

        logger.info('Initializing PostgreSQL data directory', {
            operation: 'postgres_setup',
            dataDir: this.postgresDataDir,
        });

        try {
            // Create postgres_data directory if it doesn't exist
            mkdirSync(this.postgresDataDir, { recursive: true });

            // Initialize the database cluster
            logger.info('Running initdb...');
            execSync(`initdb -D "${this.postgresDataDir}"`, {
                stdio: 'inherit',
            });

            logger.info('PostgreSQL setup completed successfully', {
                operation: 'postgres_setup',
                status: 'success',
            });
            return true;
        } catch (error) {
            logger.error('PostgreSQL setup failed', {
                operation: 'postgres_setup',
                status: 'failed',
                error: error.message,
            });
            throw new Error(`PostgreSQL setup failed: ${error.message}`);
        }
    }

    /**
     * Start PostgreSQL server
     * @returns {Promise<boolean>} True if server started successfully
     */
    async start() {
        if (!this.isInitialized()) {
            logger.info('PostgreSQL not initialized, running setup...');
            await this.setup();
        }

        if (this.isRunning()) {
            logger.warn('PostgreSQL server is already running');
            return true;
        }

        logger.info('Starting PostgreSQL server', {
            operation: 'postgres_start',
            port: this.port,
            dataDir: this.postgresDataDir,
        });

        return new Promise((resolve, reject) => {
            try {
                // Use pg_ctl to start the server
                const proc = spawn('pg_ctl', [
                    '-D', this.postgresDataDir,
                    '-l', this.postgresLogFile,
                    'start',
                    '-w', // Wait for server to start
                    '-t', '10', // Timeout after 10 seconds
                ], {
                    stdio: 'pipe',
                });

                const timeout = setTimeout(() => {
                    proc.kill();
                    reject(new Error('PostgreSQL startup timeout'));
                }, 15000);

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code === 0) {
                        // Give the server a moment to fully initialize
                        setTimeout(() => {
                            if (this.isRunning()) {
                                logger.info('PostgreSQL started successfully', {
                                    operation: 'postgres_start',
                                    status: 'success',
                                    port: this.port,
                                });
                                resolve(true);
                            } else {
                                reject(new Error('PostgreSQL process exited immediately after start'));
                            }
                        }, 500);
                    } else {
                        reject(new Error(`PostgreSQL startup failed with code ${code}`));
                    }
                });

                proc.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            } catch (error) {
                logger.error('Failed to start PostgreSQL', {
                    operation: 'postgres_start',
                    status: 'failed',
                    error: error.message,
                });
                reject(error);
            }
        });
    }

    /**
     * Stop PostgreSQL server
     * @returns {Promise<boolean>} True if server stopped successfully
     */
    async stop() {
        if (!this.isRunning()) {
            logger.debug('PostgreSQL is not running');
            return true;
        }

        logger.info('Stopping PostgreSQL server', {
            operation: 'postgres_stop',
        });

        return new Promise((resolve, reject) => {
            try {
                const proc = spawn('pg_ctl', [
                    '-D', this.postgresDataDir,
                    'stop',
                    '-m', 'fast', // Fast mode: terminate connections and shut down cleanly
                ], {
                    stdio: 'pipe',
                });

                const timeout = setTimeout(() => {
                    proc.kill('SIGKILL');
                    reject(new Error('PostgreSQL shutdown timeout'));
                }, 10000);

                proc.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code === 0) {
                        logger.info('PostgreSQL stopped successfully', {
                            operation: 'postgres_stop',
                            status: 'success',
                        });
                        resolve(true);
                    } else {
                        reject(new Error(`PostgreSQL stop failed with code ${code}`));
                    }
                });

                proc.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            } catch (error) {
                logger.error('Failed to stop PostgreSQL', {
                    operation: 'postgres_stop',
                    status: 'failed',
                    error: error.message,
                });
                reject(error);
            }
        });
    }

    /**
     * Get PostgreSQL status
     * @returns {Promise<{running: boolean, message: string}>}
     */
    async getStatus() {
        const running = this.isRunning();
        return {
            running,
            message: running ? 'PostgreSQL is running' : 'PostgreSQL is not running',
            port: this.port,
            dataDir: this.postgresDataDir,
            logFile: this.postgresLogFile,
        };
    }
}

export default PostgresManager;
