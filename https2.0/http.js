'use strict';

const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const Packet = require('..//Packet');
const url = require('url');
const pjson = require('./package.json');

var sequenceFollower = 0;
const router = 'http://localhost:3000';
var queue = [];
var connectionStarted = false;
var httpReply;
var closingConnection = false;

const WINDOW_SIZE = 10;


var window_buffer = [];
var sendingQueue = [];
var isSending = false;

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

function sendPacket(packet, destination) {
    if (httpReply) {
        packet.setPayload(httpReply);
    }
    var dest = url.parse(destination);
    console.log("Sending packet #" + packet.sequenceNumber + "type: " + packet.type);
    socket.send(packet.getBuffer(), dest.port, dest.hostname);
}

function addToQueue(pk, expected, httpServer) {
    if (queue.length === 0 || queue[queue.length - 1].seq < pk.sequenceNumber) {
        queue.push({
            seq: pk.sequenceNumber,
            data: pk.payload,
            address: pk.address,
            port: pk.port,
            isFIN: pk.type === 4 ? true : false
        });
        if (expected === true) sequenceFollower++;
        console.log("1. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));
    } else if (queue[0].seq > pk.sequenceNumber) {
        queue.unshift({
            seq: pk.sequenceNumber,
            data: pk.payload,
            address: pk.address,
            port: pk.port,
            isFIN: pk.type === 4 ? true : false
        });
        if (expected === true) {
            var lastInOrder = sequenceFollower;
            for (var j = 0; j < queue.length; j++) {
                var lastInOrder = queue[j].seq;
                if (!queue[j + 1] || queue[j + 1].seq - queue[j].seq > 1)
                    break;
            }
            sequenceFollower = lastInOrder + 1;
        }
        console.log("2. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));

    } else {

        for (var i = queue.length - 1; i >= 0; i--) {
            if (queue[i].seq === pk.sequenceNumber) return;
            if (queue[i].seq < pk.sequenceNumber) {
                queue.splice((i + 1), 0, {
                    seq: pk.sequenceNumber,
                    data: pk.payload,
                    address: pk.address,
                    port: pk.port,
                    isFIN: pk.type === 4 ? true : false
                });
                if (expected === true) {
                    var lastInOrder = sequenceFollower;
                    for (var j = (i !== 0 ? i + 1 : 0); j < queue.length; j++) {
                        var lastInOrder = queue[j].seq;
                        if (!queue[j + 1] || queue[j + 1].seq - queue[j].seq > 1)
                            break;
                    }
                    sequenceFollower = lastInOrder + 1;
                }
                console.log("3. Queue has: "); console.log(queue.reduce((result, cur) => { return result += ', ' + cur.seq }, ''));
                break;
            }
        }
    }
    if (expected)
        checkDelivery(httpServer);
}

function checkDelivery(httpServer) {
    if (queue[queue.length - 1].isFIN && queue[queue.length - 1].seq === sequenceFollower - 1) {
        console.log("Send reply");
        var packet = (new Packet()).setType(2)
            .setAddress(queue[queue.length - 1].address)
            .setPort(queue[queue.length - 1].port)
            .setSequenceNumber(sequenceFollower)
            .setPayload(httpReply);
        sendPacket(packet, router);
        httpServer.deliverQueue();
        closingConnection = true;
    }
}

function flush() {
    queue = [];
    sequenceFollower = 0;
    closingConnection = false;
}

function httpServer(port, get, post, logger) {
    httpServer.prototype.logger = logger ? function () { this.log() = function () { } } : logger;
    httpServer.prototype.get = get ? get : function () { };
    httpServer.prototype.post = post ? post : function () { };
    var that = this;

    socket.on('listening', () => {
        var address = socket.address();
        console.log(`server listening ${address.address}:${address.port}`);
    });
    socket.on('message', (msg, rinfo) => {

        var packet = Packet.createFromBuffer(msg);
        console.log(`server got: ${packet.sequenceNumber} type ${packet.type} expecting ${sequenceFollower} and ${connectionStarted}`);
        if(!isSending){
            if (packet.type === 0) {
                sequenceFollower = packet.sequenceNumber + 1;
                var packet = packet.copy()
                    .setType(1)
                    .setSequenceNumber(sequenceFollower);
                sendPacket(packet, router);
            } else if (packet.type === 2) {
                console.log("here2");
                if (packet.sequenceNumber == sequenceFollower) {
                    sequenceFollower++;
                    console.log("Connection Change");
                    connectionStarted = !connectionStarted;
                    if (closingConnection) {
                        clearInterval(queue[queue.length - 1].timer);
                    }
                    if (!connectionStarted) {
                        flush();
                    }
                }
            } else if (packet.type == 3 && connectionStarted) {
                console.log('here3');
                if (packet.sequenceNumber == sequenceFollower)
                    addToQueue(packet, true, this);
                else if (packet.sequenceNumber > sequenceFollower)
                    addToQueue(packet, false);
                sendAcknowledgement(packet);
            } else if (packet.type == 4 && connectionStarted) {
                if (packet.sequenceNumber > sequenceFollower &&
                    packet.sequenceNumber !== sequenceFollower)
                    addToQueue(packet, false);
                sendAcknowledgement(packet);
                if (packet.sequenceNumber === sequenceFollower) {
                    httpReply = this.deliverQueue();
                    closingConnection = true;
                }
            }
        }else{
            removeFromWindow(packet.sequenceNumber);
        }
        console.log("SEQ NUMBER IS: " + sequenceFollower);
    });

    socket.bind(1234);

    httpServer.prototype.sendReply = function (socket, code, body, path) {
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

    this.deliverQueue = function () {
        console.log(queue);
        var request = queue.reduce((req, pk) => {
            console.log(pk.data);
            return req + pk.data;
        }, '');
        console.log('Request:\n' + request + '\n');
        if (request.startsWith('GET'))
            httpReply = that.get(socket, request);
        else if (request.startsWith('POST'))
            httpReply = that.post(socket, request);
        else
            httpReply = that.sendReply(socket, "400");
        console.log('start transmittion');
        var packet = (new Packet())
            .setAddress(queue[queue.length - 1].address)
            .setPort(queue[queue.length - 1].port)
        var seq = startTransmittion(httpReply, packet);
        console.log('after transmittion');
        packet.setType(4)
            .setAddress(queue[queue.length - 1].address)
            .setPort(queue[queue.length - 1].port)
            .setSequenceNumber(seq)
            .setPayload('');

        addToSendingQueue(packet);
    }
}

function sendAcknowledgement(oldPk) {
    var packet = oldPk.copy()
        .setType(2)
        .setSequenceNumber(sequenceFollower)
        .setPayload('');
    sendPacket(packet, router);
}

// ====================Sender==========================

function startTransmittion(httpRequest, lastPack) {
    isSending = true;
    var sending = [];
    if (httpRequest.length > 1013) {
        var packets = Math.floor(httpRequest.length / 1013);
        var rest = httpRequest.length % 1013;
        console.log("Length: " + httpRequest.length + ', packets: ' + packets + ', rest: ' + rest);
        var contents = [];
        var i = 0;
        for (i = 0; i <= packets - 1; i++) {
            contents.push(httpRequest.substring(0 + (1013 * i), 1013 + (1013 * i)));
        }
        contents.push(httpRequest.substring(1013 + (1013 * (packets - 1))));
        httpRequest = contents;
    }
    console.log(httpRequest);
    var seq = ++sequenceFollower;
    if (typeof httpRequest == 'string') {
        var Pn = lastPack.copy()
            .setType(3)
            .setSequenceNumber(seq++)
            .setPayload(httpRequest);
        console.log('sending data');
        addToSendingQueue(Pn);
    } else {
        for (var i in httpRequest) {
            var Pn = lastPack.copy()
                .setType(3)
                .setSequenceNumber(seq++)
                .setPayload(httpRequest[i]);

            addToSendingQueue(Pn)
        }
    }
    return seq;

}

function removeFromWindow(arrivedSeq){
        console.log("remove up to: " + arrivedSeq);
        console.log('window size: ' + window_buffer.length+ 'queue size: '+sendingQueue.length);
        if(window_buffer.length > 0 && arrivedSeq < window_buffer[0].seq ) return;
        console.log(window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
        var i = 0;
        while(window_buffer.length !== 0 && window_buffer[0].seq <= arrivedSeq-1){
            clearInterval(window_buffer.shift().timer);
            i++;
        }
                
        console.log(window_buffer.reduce((result, cur)=>{return result += ', '+cur.seq}, ''));
        var toSend = sendingQueue.splice(0 ,i);
        for(var j in toSend){
            addToWindowAndSend(toSend[j]);
        }
        return;
    }

    function addToWindowAndSend(pk){
        window_buffer.push({
            seq : pk.sequenceNumber,
            packet : pk,
            timer: setInterval(function(){
                console.log("RETRANSMIT");
                sendPacket(pk, router);
            }, 2000)
        });
        console.log('Sending '+ pk.sequenceNumber+ ' - ' + pk.type);
        sendPacket(pk, router);
    }

    function addToSendingQueue(pk){
        if(window_buffer.length < WINDOW_SIZE){
            addToWindowAndSend(pk);
        }else
            sendingQueue.push(pk);
    }

module.exports = httpServer;