'use strict';
const url = require('url');
const pjson = require('./package.json');
const ReliableDataTransfer= require('../rdt');
const EventEmitter = require('events');

class MyEventEmitter extends EventEmitter {};

const statusCode = {
    200: {
        message: "OK",
        body: ""
    },
    201: {
        message: "Created",
        body: `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>201 Created</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>All Good! resource was created</h1>
                        </body>
                        </html>`
    },
    400: {
        message: "Bad Request",
        body: ""
    },
    403: {
        message: "Forbidden",
        body: `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>403 Forbidden</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Access Forbidden</h1>
                            <p>Sorry, you do not have access to this resource.</p>
                        </body>
                        </html>`
    },
    404: {
        message: "Not Found",
        body: `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>Page Not Found</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Page Not Found</h1>
                            <p>Sorry, but the page you were trying to view does not exist.</p>
                        </body>
                        </html>`
    },
    500: {
        message: "Internal Server Error",
        body: `<!doctype html>
                        <html lang="en">
                        <head>
                            <meta charset="utf-8">
                            <title>500 Server Error</title>
                            <meta name="viewport" content="width=device-width, initial-scale=1">
                        </head>
                        <body>
                            <h1>Internal Server Error</h1>
                            <p>There was a problem with the server, try again later</p>
                        </body>
                        </html>`
    }
}

const MINE_TYPES = {
    "html": {
        ContentType: "text/html"
    },
    "json": {
        ContentType: "application/json"
    },
    "undefined": {
        ContentType: "undefined",
        ContentDisposition: "attachment"
    },
    "pdf": {
        ContentType: "application/pdf",
        ContentDisposition: "attachment"
    },
    "jpeg": {
        ContentType: "image/jpeg",
        ContentDisposition: "attachment"
    },
    "jpg": {
        ContentType: "image/jpeg",
        ContentDisposition: "attachment"
    },
    "png": {
        ContentType: "image/png",
        ContentDisposition: "attachment"
    },
    "xml": {
        ContentType: "application/xlm"
    }
}

var getDocumentType = function (code, path, body) {
    if (code === "200") {
        var splitPath = path.split('/');
        var file = (splitPath[splitPath.length - 1].split('.'));
        return (file[1]) ? file[1] : 'undefined';
    } else
        return 'html';
}

function httpServer(port, get, post, logger) {
    httpServer.prototype.logger = logger ? function () { this.log() = function () { } } : logger;
    httpServer.prototype.get = get ? get : function () { };
    httpServer.prototype.post = post ? post : function () { };
    var that = this;

    const eventEmitter = new MyEventEmitter();

    eventEmitter.on('messageArrived', (httpRequest)=>{
           var httpReply;
            console.log('got request');
            if (httpRequest.startsWith('GET'))
                httpReply = that.get(httpRequest);
            else if (httpRequest.startsWith('POST'))
                httpReply = that.post(httpRequest);
            else
                httpReply = that.sendReply("400");
            console.log('sending');
            rdt.sendReply(httpReply, url.parse("http://127.0.0.1:8000")).then(()=>{
                console.log('reply Sent');
            });
    });

    var rdt =  new ReliableDataTransfer(1234, eventEmitter);
    rdt.receive();

    

    httpServer.prototype.sendReply = function (code, body, path) {
        var status = statusCode[code];
        var docType = MINE_TYPES[getDocumentType(code, path)];
        if (!docType) {
            docType = {
                ContentType: "text/plain"
            }
        }
        if (body && typeof body !== 'string')
            body = body.join('\r\n');
        // Header
        // Status
        var reply = 'HTTP/1.1 ' + code + ' ' + status.message + '\r\n'
        // General Header
        reply += 'Date: ' + (new Date()).toString() + '\r\n';
        // Response Headers
        reply += 'Server: ' + pjson.name + '/' + pjson.version + '\r\n';
        // Entity Header
        reply += 'Content-Type: ' + docType.ContentType + '\r\n';
        reply += docType.ContentDisposition ? 'Content-Disposition: ' + docType.ContentDisposition + '\r\n' : '';
        reply += 'Content-Length: ' + (body ? body.length + 4 : 0) + '\r\n';
        // body
        reply += '\r\n\r\n';
        if (body) {
            reply += (typeof body === 'string' ? body : body.join('\r\n')) + '\r\n';
        } else {
            reply += status.body + '\r\n';
        }
        // End
        reply += '\r\n';
        //Send
        logger.log("sending reply:\n");
        logger.log(reply);
        return reply;
    }
}



module.exports = httpServer;