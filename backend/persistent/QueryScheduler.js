import {has} from 'ramda';

import {getConnectionById} from './Connections.js';
import * as Connections from './datastores/Datastores.js';
import Logger from '../logger';
import {
    getQuery,
    getQueries,
    saveQuery,
    deleteQuery
} from './Queries.js';
import {
    getCredentials,
    getSetting
} from '../settings.js';
import {
    getCurrentUser,
    getGridMeta,
    newGrid,
    updateGrid
} from './plotly-api.js';

class QueryScheduler {
    constructor() {
        this.scheduleQuery = this.scheduleQuery.bind(this);
        this.loadQueries = this.loadQueries.bind(this);
        this.clearQuery = this.clearQuery.bind(this);
        this.clearQueries = this.clearQueries.bind(this);
        this.queryAndCreateGrid = this.queryAndCreateGrid.bind(this);
        this.queryAndUpdateGrid = this.queryAndUpdateGrid.bind(this);

        // this.job wraps this.queryAndUpdateGrid to avoid concurrent runs of the same job
        this.runningJobs = {};
        this.job = (fid, uids, query, connectionId, requestor) => {
            try {
                if (this.runningJobs[fid]) {
                    return;
                }

                this.runningJobs[fid] = true;

                return this.queryAndUpdateGrid(fid, uids, query, connectionId, requestor)
                    .catch(error => {
                        Logger.log(error, 0);
                    }).then(() => {
                        delete this.runningJobs[fid];
                    });
            } catch (e) {
                Logger.log(e, 0);
            }
        };

        // Expose this.minimumRefreshInterval so that tests can overwrite it
        this.minimumRefreshInterval = 60;
        this.queryJobs = {};
    }

    scheduleQuery({
        requestor,
        fid,
        uids,
        refreshInterval,
        query,
        connectionId
    }) {
        if (!refreshInterval) {
            throw new Error('Refresh interval was not supplied');
        } else if (refreshInterval < this.minimumRefreshInterval) {
            throw new Error([
                `Refresh interval must be at least ${this.minimumRefreshInterval} seconds`,
                `(supplied ${refreshInterval})`
            ].join(' '));
        }

        Logger.log(`Scheduling "${query}" with connection ${connectionId} updating grid ${fid}`);

        // Delete query if it is already saved
        if (getQuery(fid)) {
            deleteQuery(fid);
        }

        // Remove the query from the in-memory timers
        if (has(fid, this.queryJobs)) {
            this.clearQuery(fid);
        }

        // Save query to a file
        saveQuery({
            requestor,
            fid,
            uids,
            refreshInterval,
            query,
            connectionId
        });

        // Schedule
        this.queryJobs[fid] = setInterval(
            () => {
                this.job(fid, uids, query, connectionId, requestor);
            },
            refreshInterval * 1000
        );
    }

    // Load and schedule queries - To be run on app start.
    loadQueries() {
        // read queries from a file
        const queries = getQueries();
        queries.forEach(this.scheduleQuery);
    }

    // Remove query from memory
    clearQuery(fid) {
        clearInterval(this.queryJobs[fid]);
        delete this.queryJobs[fid];
    }

    // Clear out setInterval queries from memory - used to clean up tests
    clearQueries() {
        Object.keys(this.queryJobs).forEach(this.clearQuery);
    }

    queryAndCreateGrid(filename, query, connectionId, requestor) {
        const {username, apiKey, accessToken} = getCredentials(requestor);
        let startTime;

        // Check if the user even exists
        if (!username || !(apiKey || accessToken)) {
            /*
             * Warning: The front end looks for "Unauthenticated" in this error message. Don't change it!
             */
            const errorMessage = (
                'Unauthenticated: Attempting to create a grid but the ' +
                `authentication credentials for the user "${username}" do not exist.`
            );
            Logger.log(errorMessage, 0);
            throw new Error(errorMessage);
        }

        // Check if the credentials are valid
        return getCurrentUser(username).then(res => {
            if (res.status !== 200) {
                const errorMessage = (
                    `Unauthenticated: ${getSetting('PLOTLY_API_URL')} failed to identify ${username}.`
                );
                Logger.log(errorMessage, 0);
                throw new Error(errorMessage);
            }


            startTime = process.hrtime();

            Logger.log(`Querying "${query}" with connection ${connectionId} to create a new grid`, 2);
            return Connections.query(query, getConnectionById(connectionId));

        }).then(({rows, columnnames}) => {
            Logger.log(`Query "${query}" took ${process.hrtime(startTime)[0]} seconds`, 2);
            Logger.log('Create a new grid with new data', 2);
            Logger.log(`First row: ${JSON.stringify(rows.slice(0, 1))}`, 2);

            startTime = process.hrtime();

            return newGrid(
                filename,
                columnnames,
                rows,
                requestor
            );

        }).then(res => {
            Logger.log(`Request to Plotly for creating a grid took ${process.hrtime(startTime)[0]} seconds`, 2);

            if (res.status !== 201) {
                Logger.log(`Error ${res.status} while creating a grid`, 2);
            }

            return res.json().then((json) => {
                Logger.log(`Grid ${json.file.fid} has been updated.`, 2);
                return json;
            });
        });

    }

    queryAndUpdateGrid(fid, uids, query, connectionId, requestor) {
        const requestedDBConnections = getConnectionById(connectionId);
        let startTime = process.hrtime();

        /*
         * Do a pre-query check that the user has the correct credentials
         * and that the connector can connect to plotly
         */
        /*
         * If the user is the owner, then requestor === fid.split(':')[0]
         * If the user is a collaborator, then requestor is different
         */
        const {username, apiKey, accessToken} = getCredentials(requestor);

        // Check if the user even exists
        if (!username || !(apiKey || accessToken)) {
            /*
             * Warning: The front end looks for "Unauthenticated" in this error message. Don't change it!
             */
            const errorMessage = (
                `Unauthenticated: Attempting to update grid ${fid} but the ` +
                `authentication credentials for the user "${username}" do not exist.`
            );
            Logger.log(errorMessage, 0);
            throw new Error(errorMessage);
        }

        // Check if the credentials are valid
        return getCurrentUser(username).then(res => {
            if (res.status !== 200) {
                const errorMessage = (
                    `Unauthenticated: ${getSetting('PLOTLY_API_URL')} failed to identify ${username}.`
                );
                Logger.log(errorMessage, 0);
                throw new Error(errorMessage);
            }

            Logger.log(`Querying "${query}" with connection ${connectionId} to update grid ${fid}`, 2);
            return Connections.query(query, requestedDBConnections);

        }).then(({rows}) => {

            Logger.log(`Query "${query}" took ${process.hrtime(startTime)[0]} seconds`, 2);
            Logger.log(`Updating grid ${fid} with new data`, 2);
            Logger.log(
                'First row: ' +
                JSON.stringify(rows.slice(0, 1)),
            2);

            startTime = process.hrtime();

            return updateGrid(
                rows,
                fid,
                uids,
                requestor
            );

        }).then(res => {
            Logger.log(`Request to Plotly for grid ${fid} took ${process.hrtime(startTime)[0]} seconds`, 2);
            if (res.status !== 200) {
                Logger.log(`Error ${res.status} while updating grid ${fid}.`, 2);

                /*
                 * If it was a 404 error and the requestor was the owner, then
                 * it might've been because the owner has deleted their grid.
                 * If it was a 404 and the requestor wasn't the owner,
                 * then either the owner has deleted the grid or the
                 * requestor no longer has permission to view the graph.
                 * In any case, delete the query.
                 * Note that when a user is requesting to update or save
                 * a query via `post /queries`, we first check that they have
                 * permission to edit the file. Otherwise, this code block
                 * could delete an owner's grid when given any request by
                 * a non-collaborator.
                 * In Plotly, deletes can either be permenant or non-permentant.
                 * Delete the query in either case.
                 */

                /*
                 * Plotly's API returns a 500 instead of a 404 in these
                 * PUTs. To check if the file is really there or not,
                 * make an additional API call to GET it
                 */

                return getGridMeta(fid, username).then(resFromGET => {
                    if (resFromGET.status === 404) {
                        Logger.log(`Grid ID ${fid} doesn't exist on Plotly anymore, removing persistent query.`, 2);
                        this.clearQuery(fid);
                        return deleteQuery(fid);
                    }

                    return resFromGET.text()
                    .then(text => {
                        let filemeta;
                        try {
                            filemeta = JSON.parse(text);
                        } catch (e) {
                            Logger.log(`Failed to parse the JSON of request ${fid}`, 0);
                            Logger.log(e);
                            Logger.log('Text response: ' + text, 0);
                            throw new Error(e);
                        }
                        if (filemeta.deleted) {
                            Logger.log(`
                                Grid ID ${fid} was deleted,
                                removing persistent query.`,
                                2
                            );
                            this.clearQuery(fid);
                            return deleteQuery(fid);
                        }
                    });
                });

            }

            return res.json().then(() => {
                Logger.log(`Grid ${fid} has been updated.`, 2);
            });
        });

    }

}

export default QueryScheduler;


// TODO - do we allow the user to change their connection
// and all of their saved queries? if we save
// serializedConfiguration in plotly, then that'll be hard to
// update.
// or wait, no it won't, we can just make an API call to the
// grid and update it.
