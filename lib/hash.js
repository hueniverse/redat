'use strict';

// Load modules

const Querystring = require('querystring');
const Hoek = require('hoek');

const Base = require('./base');
const Utils = require('./utils');


// Declare internals

const internals = {};


internals.defaults = {
    updates: false,
    configure: false
};


exports = module.exports = internals.Client = class extends Base {

    constructor(options, _subscriber) {

        super(Hoek.applyToDefaults(internals.defaults, options || {}));

        if (this.settings.updates &&
            !_subscriber) {

            this._subscriber = new internals.Client(this.settings, true);
            this._subs = {};                                                // key -> { key, [callbacks], last }
        }
    }

    connect(callback) {

        super.connect((err) => {

            if (err) {
                return callback(err);
            }

            if (this._subscriber) {
                return this._initializeUpdates(callback);
            }

            return callback();
        });
    }

    disconnect(callback) {

        super.disconnect((err) => {

            if (this._subscriber) {                                 // Ignore error when subscriber exists
                return this._subscriber.disconnect(callback);
            }

            return callback(err);
        });
    }

    get(key, fields, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'));
        }

        // Specific fields

        if (fields) {
            if (Array.isArray(fields)) {

                // Multiple fields

                this.redis.hmget(key, fields, (err, results) => {

                    if (err) {
                        return callback(err);
                    }

                    const item = {};
                    for (let i = 0; i < fields.length; ++i) {
                        const field = fields[i];
                        item[field] = results[i];
                    }

                    return this._parse(item, callback);
                });

                return;
            }

            // Single field

            this.redis.hget(key, fields, (err, result) => {

                if (err) {
                    return callback(err);
                }

                if (!result) {
                    return callback(null, null);
                }

                const item = {};
                item[fields] = result;
                return this._parse(item, callback);
            });

            return;
        }

        // All fields

        this.redis.hgetall(key, (err, result) => {

            if (err) {
                return callback(err);
            }

            if (!result) {
                return callback(null, null);
            }

            return this._parse(result, callback);
        });
    }

    _parse(item, next) {

        const result = {};
        const fields = Object.keys(item);
        for (let i = 0; i < fields.length; ++i) {
            const name = fields[i];
            const value = item[name];
            const parsed = Base.parse(value);
            if (parsed instanceof Error) {
                return next(parsed);
            }

            result[name] = parsed;
        }

        return next(null, result);
    }

    set(key, field, value, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'));
        }

        const redis = this.redis;                   // In case disconnected in between calls

        const process = (err, changes) => {

            if (err) {
                return callback(err);
            }

            return this._publish(redis, key, 'hset', Querystring.stringify(changes), callback);
        };

        // Single field

        if (field) {
            const valueString = Base.stringify(value);
            if (valueString instanceof Error) {
                return Hoek.nextTick(callback)(valueString);
            }

            return redis.hset(key, field, valueString, (err, created) => process(err, { [field]: valueString }));
        }

        // Multiple fields

        const pairs = {};
        const fields = Object.keys(value);
        for (let i = 0; i < fields.length; ++i) {
            const name = fields[i];

            const valueString = Base.stringify(value[name]);
            if (valueString instanceof Error) {
                return Hoek.nextTick(callback)(valueString);
            }

            pairs[name] = valueString;
        }

        return redis.hmset(key, pairs, (err) => process(err, pairs));
    }

    expire(key, ttl, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'));
        }

        return this.redis.pexpire(key, ttl, Utils.sanitize(callback));
    }

    increment(key, field, options, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'));
        }

        const redis = this.redis;                   // In case disconnected in between calls

        const maxHandler = (!options.maxField ? '' : `
                redis.call('hsetnx', '${key}', '${options.maxField}', 0)
                local max = redis.call('hget', '${key}', '${options.maxField}')
                if tonumber(value) > tonumber(max) then
                    redis.call('hset', '${key}', '${options.maxField}', value)
                    return { value, 1 }
                end`);

        const increment = (options.increment !== undefined ? options.increment : 1);

        const script =
            `if redis.call('hexists', '${key}', '${field}') == 1 then
                local value = redis.call('hincrby', '${key}', '${field}', ${increment})` + maxHandler +
            `   return { value, 0 }
            else
                return nil
            end`;

        return redis.eval(script, 0, (err, updated) => {

            if (err) {
                return callback(err);
            }

            if (updated === null) {
                return callback(null, null);        // Explicitly set value to null
            }

            const changes = { [field]: updated[0] };
            if (updated[1]) {
                changes[options.maxField] = updated[0];
            }

            return this._publish(redis, key, 'hset', Querystring.stringify(changes), (err) => callback(err, updated[0]));
        });
    }

    drop(key, field, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'));
        }

        if (!field) {
            return this.redis.del(key, Utils.sanitize(callback));
        }

        const redis = this.redis;                   // In case disconnected in between calls

        return redis.hdel(key, field, (err, count) => {

            if (err) {
                return callback(err);
            }

            if (!count) {
                return callback();
            }

            return this._publish(redis, key, 'hdel', encodeURIComponent(field), callback);
        });
    }

    lock(key, ttl, callback) {

        if (!this.redis) {
            return Hoek.nextTick(callback)(new Error('Redis client disconnected'), false);
        }

        const script = `if redis.call('exists', '${key}') == 1 then return nil else return redis.call('psetex', '${key}', '${ttl}', '1') end`;
        return this.redis.eval(script, 0, (err, locked) => {

            if (err) {
                return callback(err, false);
            }

            return callback(null, locked !== null);
        });
    }

    unlock(key, callback) {

        return this.drop(key, null, callback);
    }

    subscribe(key, each, callback) {

        Hoek.assert(this._subscriber, 'Updates disabled');

        if (this._subs[key]) {
            this._subs[key].callbacks.push(each);
            return callback();
        }

        this._subs[key] = { callbacks: [each], last: null };
        this._subscriber.redis.subscribe(`__keyspace@0__:${key}`, `hippo_hash:${key}`, Utils.sanitize(callback));
    }

    unsubscribe(key, each, callback) {

        Hoek.assert(this._subscriber, 'Updates disabled');

        const nextTickCallback = Hoek.nextTick(callback);

        const subs = this._subs[key];
        if (!subs) {
            return nextTickCallback();
        }

        // Unsubscribe all

        if (!each) {
            delete this._subs[key];
            return this._subscriber.redis.unsubscribe(`__keyspace@0__:${key}`, `hippo_hash:${key}`, Utils.sanitize(callback));
        }

        // Unsubscribe one

        const pos = subs.callbacks.indexOf(each);
        if (pos === -1) {
            return nextTickCallback();
        }

        if (subs.callbacks.length === 1) {                                  // Last subscriber
            delete this._subs[key];
            return this._subscriber.redis.unsubscribe(`__keyspace@0__:${key}`, `hippo_hash:${key}`, Utils.sanitize(callback));
        }

        subs.callbacks.splice(pos, 1);
        return nextTickCallback();
    }

    _configureUpdates(callback) {

        this.redis.config('SET', 'notify-keyspace-events', 'Kgxe', (err) => {

            if (err) {
                this.redis.end(false);
                return callback(err);
            }

            return callback();
        });
    };

    _initializeUpdates(callback) {

        const subscribe = () => {

            this._subscriber.connect((err) => {

                if (err) {
                    return callback(err);
                }

                this._subscriber.redis.on('message', (channel, message) => {

                    if (!this.redis) {
                        return;
                    }

                    const match = channel.match(/^(?:(?:__keyspace\@0__)|(?:hippo_hash))\:(.*)$/);
                    if (!match) {
                        return;
                    }

                    const key = match[1];
                    const subs = this._subs[key];
                    if (!subs) {
                        return;
                    }

                    if (channel[0] === '_') {
                        if (message === 'del' ||
                            message === 'expired' ||
                            message === 'evicted') {

                            subs.last = 'delete';
                            return subs.callbacks.forEach((each) => each(null, null, null));
                        }

                        return;             // Ignore all other keyspace events
                    }

                    const parts = message.split(' ');
                    const action = parts[0];

                    // hdel (if last field, a del message comes first)

                    if (action === 'hdel') {
                        if (subs.last === 'delete') {
                            return;
                        }

                        subs.last = 'update';
                        const field = internals.decode(parts[1]);
                        if (field instanceof Error) {
                            subs.last = 'error';
                            return subs.callbacks.forEach((each) => each(field));
                        }

                        return subs.callbacks.forEach((each) => each(null, null, field));
                    }

                    // hset

                    const changes = Querystring.parse(parts[1]);
                    this._parse(changes, (err, result) => {

                        if (err) {
                            subs.last = 'error';
                            return subs.callbacks.forEach((each) => each(err));
                        }

                        subs.last = 'update';
                        return subs.callbacks.forEach((each) => each(null, result));
                    });
                });

                return callback();
            });
        };

        if (!this.settings.configure) {
            return subscribe();
        }

        this._configureUpdates((err) => {

            if (err) {
                return callback(err);
            }

            return subscribe();
        });
    }

    _publish(redis, key, action, changes, next) {

        if (!this.settings.updates) {
            return next();
        }

        redis.publish(`hippo_hash:${key}`, action + ' ' + changes, Utils.sanitize(next));
    };
};


internals.decode = function (string) {

    try {
        return decodeURIComponent(string);
    }
    catch (err) {
        return err;
    }
};
