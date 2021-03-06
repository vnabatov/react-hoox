// old syntax, guys. hope nobody minds
var FLAG_NAME = '__r_a_17_';
var TRIGGER_NAME = '__r_a_27_';
var TIME_LIMIT = 50;

Object.defineProperty(exports, "__esModule", {
    value: true
});

exports.default = typeof window !== 'undefined' ? runAsModule() : runAsPlugin();


function runAsPlugin() {
    return function(args) {
        var t = args.types;

        // code 'if (window.__r_a_17_) window.__r_a_27_();'
        // todo: 'if (winodw.__r_a_17_ === true) ...' or even 'window.__r_a_17_ === true && window.__r_a_27_();'
        var injection = t.IfStatement(
            t.memberExpression(
                t.identifier('window'), t.identifier(FLAG_NAME)
            ),
            t.expressionStatement(
                t.callExpression(
                    t.memberExpression(
                        t.identifier('window'), t.identifier(TRIGGER_NAME)
                    ),
                    []
                )
            )
        );

        // insert 'injection' on top of any function declaration
        function functionInstrumenter(path) {
            // todo: options 'include' and 'exclude' - string regexp in json
            if (this.file.opts.filename.indexOf('node_modules') >= 0) return;

            var body = path.get('body');

            if (body.type !== 'BlockStatement') {
                // one-line arrow function - replace with regular block and 'return' keyword
                body.replaceWith(
                    t.BlockStatement([
                        injection,
                        t.ReturnStatement(body.node)
                    ])
                );
            } else {
                // check if already injected
                var children = body.node.body[0] ? body.node.body : [ body.node.body ];
                for (var i = 0; i < children.length; i++) {
                    var child = children[i];

                    if (child.type === 'IfStatement') {
                        if (child.test.type === 'MemberExpression') {
                            if (child.test.property.name === FLAG_NAME) {
                                return;
                            }
                        }
                    }
                }

                // and inject, if not
                body.unshiftContainer(
                    'body',
                    injection
                );
            }
        }

        return {
            visitor: {
                // includes any functions, class methods, arrows, etc...
                Function: functionInstrumenter

                // AwaitExpression, YieldExpression --> ([(await/yield ...), window.__r_a_17_ ? window.__r_a_27_() : 0][0])
                // we still can rely on transpiler for now, but in future will need to do it as well
            }
        }
    }
}


function runAsModule() {
    var _React = typeof React !== 'undefined' ? React : require('react');

    var sources = new WeakMap();
    var sourceObjects = [];

    window[FLAG_NAME] = false;   // not listen to changes
    var canSwitchOn = true;      // but allow to start listening

    // we will calculate 'resource usage'
    var timeUsed = 0;
    var perfTimer = null;
    var perfStartTime;

    // instrumented trigger '__r_a_27_'
    window[TRIGGER_NAME] = function trigger() {
        if (!window[FLAG_NAME]) return;

        window[FLAG_NAME] = false;   // don't listen (and even call) next triggers until we finish (kind of Throttle)
        canSwitchOn = false;         // can't switch on until we finish

        if (!perfTimer) {
            // refresh aggregated 'resource usage' each second
            perfStartTime = performance.now();
            perfTimer = window.setTimeout(function() {
                perfTimer = null;

                // real-time 'resource usage' logging
                var t = Math.round(timeUsed * 100) / 100;
                console.log(t + 'ms (' + Math.round(t) / 10 + '%) / sec');

                timeUsed = 0;
            }, 1000);
        }

        // delay before next calculation according to current resources usage, but not less then twice per second
        var delay = Math.max(0, Math.min(500, 1000 * (timeUsed/TIME_LIMIT) - (performance.now() - perfStartTime) ));

        window.setTimeout(function() {                  // wait at least 16ms since 60Hz on monitor
            checkUpdates();

            window[FLAG_NAME] = !!sourceObjects.length;  // run instrumental listener again, if there is observers
            canSwitchOn = true;                          // or just allow to start it later
        }, delay);
    }

    // stringify observing objects and check for changes
    function checkUpdates() {
        sourceObjects.forEach(function(o) {
            var descriptor = sources.get(o);

            // calculating new hash-code
            var hashCode = stringify(
                (typeof o.__observables === 'function')
                    ? o.__observables(o)
                    : (o.__observables || o)
            );

            if (hashCode !== descriptor.hashCode) {
                // run 'invokeRender' for each related component if changes
                descriptor.listeners.forEach(function(f) { f({}) });
                descriptor.hashCode = hashCode;
            }
        });
    }

    // stringify - calculates 'hashCode' of provided object (JSON.stringify-like, but with circular links)
    var objectCheck = Object.prototype.toString;
    var arrayCheck = Array.prototype.toString;
    var result = [], chain = [];

    function _stringify(obj) {
        if (!obj) { // undefined, null, 0, ...
        } else if (obj.toString === objectCheck || obj.toString === arrayCheck) { // any object or array
            if (chain.indexOf(obj) > -1) { // circular link
                result.push('>');
                return;
            }

            chain.push(obj);
            result.push('{');

            for (var key in obj) {
                result.push(key);
                _stringify(obj[key]);
            }

            result.push('}');
            chain.pop();
            return;
        }

        result.push('|', obj); // primitive value (or 'negative' from If above)
    }

    function stringify(obj) {
        result = [], chain = [];

        var tStart = performance.now();

        _stringify(obj);
        var hashCode = result.join('');

        var tEnd = performance.now();
        timeUsed += tEnd - tStart;

        return hashCode;
    }

    // entry point: a hook, will observe provided 'source' and re-render component on changes
    return function(source) {
        var invokeRender = null;
        try {
            // using second part of state-hook to force component re-rendering
            invokeRender = _React.useState({})[1];
        } catch (error) {}

        if (!invokeRender) {
            return source; // not a hook
        }

        // run instrumental listener, if not running
        if (canSwitchOn && !window[FLAG_NAME]) {
            window[FLAG_NAME] = true;
        }

        // create new hash-code if not observing this object yet
        var descriptor = sources.get(source);
        if (!descriptor) {
            descriptor = {
                hashCode: stringify(source), // calculating for new items firstly in render
                listeners: []
            }

            sources.set(source, descriptor);
            sourceObjects.push(source);
        }

        // if update happens before component rendered, we can't use invokeRender yet
        var isUpdateBeforeDidMount = false;
        var temporaryListener = function() { isUpdateBeforeDidMount = true };
        descriptor.listeners.push(temporaryListener);

        // todo: research case '... -> data in state A -> (x) -> write data to state B -> invoke render -> write data to state A -> (x) -> ...'

        _React.useEffect(function() {
            // replace 'temporary' listener with 'real'
            descriptor.listeners = descriptor.listeners.filter(function(f) { return f !== temporaryListener });
            descriptor.listeners.push(invokeRender);

            // run re-render if data was changed so far
            if (isUpdateBeforeDidMount) {
                invokeRender();
            }

            return function() {
                // remove listener
                descriptor.listeners = descriptor.listeners.filter(function(f) { return f !==  invokeRender });

                window.setTimeout(function() {
                    // garbage collector - remove object at all if no more listeners appears
                    if (!descriptor.listeners.length) {
                        sources.delete(source);
                        sourceObjects = sourceObjects.filter(function(o) { return o !==  source })
                    }
                }, 500);
            };
        });

        return source;
    }
}
