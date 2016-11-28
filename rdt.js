const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const Packet = require('./Packet');
const url = require('url');

const router = 'http://localhost:3000';

const WINDOW_SIZE = 10;
var queue = [];
var window_buffer = [];

var connection = false;
var connectionStarted = false;
var closingConnection =false;

var isSender;
var isSending;
var message;

var lastSequenceSent;

var sequenceFollower = 0;

var request;
var eventResolve;

var events;

function ReliableDataTransfer(port, eventEmitter, sender) {
    events = eventEmitter;
    this.port = port;
    console.log('RDT');
    isSender = (sender || sender === true) ? true : false;
    socket.bind({
            address: 'localhost',
            port: port,
            exclusive: true
            }, ()=> {});
    this.sendAndWaitForReply = function(message, receiverAddress){
        request = message;
        return new Promise((resolve, reject) =>{
            eventResolve = resolve;
                isSending = true;
                var firstPacket = (new Packet())
                                    .setType(0)
                                    .setSequenceNumber(sequenceFollower)
                                    .setAddress(receiverAddress.hostname)
                                    .setPort(receiverAddress.port)
                                    .setPayload('');
                addToSendingQueue(firstPacket);
        });
    }

    this.sendReply = function(message, receiverAddress){
        request = message;
         isSending = true;
        return new Promise((resolve, reject) =>{
            eventResolve = resolve;
            var firstPacket = (new Packet())
                                .setType(0)
                                .setSequenceNumber(sequenceFollower)
                                .setAddress(receiverAddress.hostname)
                                .setPort(receiverAddress.port)
                                .setPayload('');
            addToSendingQueue(firstPacket);
        });
    }

    this.receive =  function(){
        return new Promise((resolve, reject) =>{
            eventResolve = resolve;
            isSending = false;
        })
        
    }    
}

module.exports = ReliableDataTransfer;

//========================== SOCKET LISTENERS===============================

socket.on('listening', ()=>{
    console.log("listening");
});

socket.on('message', (msg, rinfo) => {
    var packet = Packet.createFromBuffer(msg);
    console.log(`host received: ${packet.sequenceNumber} type ${packet.type}`);
    if(isSending)
        senderHandler(packet);
    else
        receiverHandler(packet);

    if(message && !isSending){
        console.log('resolve');
        eventResolve(message);
        message = undefined;
    }
        
});

function deliverQueue () {
    console.log('deliver');
    var request = queue.reduce((req, pk) => {
            return req + pk.data;
        }, '');
    message = request;
    if(isSender){
        var packet = (new Packet()).setType(4)
                    .setAddress(queue[queue.length - 1].address)
                    .setPort(queue[queue.length - 1].port)
                    .setSequenceNumber(sequenceFollower)
                    .setPayload('');
        sendPacket(packet, router);

        setTimeout(()=>{
            socket.close();
        }, 2000);
    }
    queue = [];
    connection = false;
    if(!isSender)
        events.emit('messageArrived', message);
}



function senderHandler(packet){
    if(packet.type == 1){             // SYN + ACK
        connection = true;
        removeFromWindow(packet.sequenceNumber);
        packet = packet.setType(2);
        addToSendingQueue(packet);
        // Connection estabilished
        var seq = startTransmittion(request, packet);
        // Send Close connection signal
        var FINPk = packet.copy()
                        .setType(4)
                        .setSequenceNumber(seq)
                        .setPayload('');
        addToSendingQueue(FINPk);
        lastSequenceSent = seq;
    }else if(packet.type == 2 && connection){           // ACK
        // Pop Cumulative ack from window
        var seq = packet.sequenceNumber;
        if(packet.sequenceNumber -1 === lastSequenceSent){
            if(isSender)
                isSending = false;
            else
                flushReceiver();
            seq++;
        }
        removeFromWindow(seq);

    }else if(packet.type == 4 && connection){           // FIN + ACK
        removeFromWindow(packet.sequenceNumber);
        console.log(packet.payload);
        console.log("Sending last");
        var last = packet.copy()
                        .setType(2)
                        .setPayload('');
        // Send and don't add to window
        sendPacket(last, router);
        
            isSending = false;
        // RESET RECEIVER
        if(!isSender)    
            flushReceiver();
        return;
    }else if(packet.type == 5 && connection)         // NACK
        retransmit(packet.sequenceNumber);
}

function receiverHandler(packet){
    if (packet.type === 0) {
        sequenceFollower = packet.sequenceNumber + 1;
        var packet = packet.copy()
            .setType(1)
            .setSequenceNumber(sequenceFollower);
        sendPacket(packet, router);
    } else if (packet.type === 2) {
        if (packet.sequenceNumber == sequenceFollower) {
            sequenceFollower++;
            console.log("Connection Change");
            connectionStarted = !connectionStarted;
            if (closingConnection && !isSender)
                clearInterval(queue[queue.length - 1].timer);
            if (!connectionStarted)
                flush();
        }
    } else if (packet.type == 3 && connectionStarted) {
        console.log('expected is ' + sequenceFollower);
        if (packet.sequenceNumber == sequenceFollower)
            addToQueue(packet, true, this);
        else if (packet.sequenceNumber > sequenceFollower)
            addToQueue(packet, false);
        sendAcknowledgement(packet);
    } else if (packet.type == 4 && connectionStarted) {
        if (packet.sequenceNumber > sequenceFollower &&
            packet.sequenceNumber !== sequenceFollower){
                addToQueue(packet, false);
                sendAcknowledgement(packet);
            }
            if (packet.sequenceNumber === sequenceFollower) {
                sequenceFollower++;
                sendAcknowledgement(packet);
                if(!isSender)
                    addToWindowAndSend(packet.copy()
                                    .setType(2)
                                    .setSequenceNumber(sequenceFollower)
                                    .setPayload(''));
                else
                    sendAcknowledgement(packet);
                deliverQueue();
                
            }
        
    }
}


// SENDER FUNCTIONS

function retransmit(seq){
    removeFromWindow(seq);
    sendPacket(window_buffer[0].packet, router);
}

function removeFromWindow(arrivedSeq){
    console.log("remove up to: " + arrivedSeq);
    if(window_buffer.length > 0 && arrivedSeq <= window_buffer[0].seq ) return;
    console.log(window_buffer.reduce((result, cur)=>{return result += cur.seq + ', '}, ''));
    var i = 0;
    while(window_buffer.length !== 0 && window_buffer[0].seq <= arrivedSeq-1){
        clearInterval(window_buffer.shift().timer);
        i++;
    }
            
    console.log(window_buffer.reduce((result, cur)=>{return result += cur.seq + ', '}, ''));
    var toSend = queue.splice(0 ,i);
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
        }, 900)
    });
    sendPacket(pk, router);
}

function addToSendingQueue(pk){
    if(window_buffer.length < WINDOW_SIZE){
        addToWindowAndSend(pk);
    }else
        queue.push(pk);
}

function startTransmittion(httpRequest, lastPack){

    if(httpRequest.length > 1013){
        var packets = Math.floor(httpRequest.length/1013);
        var rest = httpRequest.length % 1013;
        console.log("Length: "+ httpRequest.length + ', packets: '+packets+ ', rest: '+rest);
        var contents = [];
        var i = 0;
        for(i = 0; i <= packets-1; i++){
            contents.push(httpRequest.substring(0 + (1013*i), 1013 + (1013*i)));
        }
        contents.push(httpRequest.substring(1013 + (1013*(packets-1))));
        httpRequest = contents;
    }
    var seq = lastPack.sequenceNumber + 1;
    if(typeof httpRequest == 'string'){
        var Pn = lastPack.copy()
                    .setType(3)
                    .setSequenceNumber(seq++)
                    .setPayload(httpRequest);

        addToSendingQueue(Pn);
    }else{
        for(var i in httpRequest){
            var Pn = lastPack.copy()
                        .setType(3)
                        .setSequenceNumber(seq++)
                        .setPayload(httpRequest[i]);

            addToSendingQueue(Pn)
        }
    }
    return seq;
}

function sendPacket(packet, destination){
    var dest = url.parse(destination);
    var buffer = packet.getBuffer();
    console.log("Sending packet #"+packet.sequenceNumber+ "type: "+packet.type + " to : " + dest.hostname+':'+dest.port);
    socket.send(buffer, 0, buffer.length, dest.port, dest.hostname);
}

// RECEIVER FUNCTIONS

function checkDelivery(httpServer){
    if(queue[queue.length-1].isFIN && queue[queue.length-1].seq === sequenceFollower -1){
        console.log("Send reply");
        var packet = (new Packet()).setType(2)
                            .setAddress(queue[queue.length-1].address)
                            .setPort(queue[queue.length-1].port)
                            .setSequenceNumber(sequenceFollower)
                            .setPayload('');
        sendPacket(packet, router);
        deliverQueue();
        closingConnection = true;
    }
}

function flush(){
    queue = [];
    sequenceFollower = 0;
    closingConnection = false;
}

function sendAcknowledgement(oldPk) {
    var packet = oldPk.copy()
        .setType(2)
        .setSequenceNumber(sequenceFollower)
        .setPayload('');
    sendPacket(packet, router);
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

function flushReceiver(){
    connection = false;
    connectionStarted = false;
    closingConnection = false;
    isSending = false;
    eventResolve(message);
}

