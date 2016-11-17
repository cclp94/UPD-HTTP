function Packet(){
    this.type;
    this.sequenceNumber;
    this.address;
    this.port;
    this.payload;

    this.setType = function(type){
        this.type = type;
        return this;
    };

    this.setSequenceNumber = function(sequenceNumber){
        this.sequenceNumber = sequenceNumber;
        return this;
    };

    this.setAddress = function(address){
        this.address = address;
        return this;
    };

    this.setPort = function(port){
        this.port = port;
        return this;
    };

    this.setPayload = function(payload){
        this.payload = payload;
        return this;
    };

    this.getBuffer = function(){
        
var bufferLength = 11 + (this.payload ? this.payload.length : 0);
        var pointer = 0;
        var packet = Buffer.alloc(bufferLength);
        // Set type
        packet.writeUInt8(this.type, 0);
        // Set sequenceNumber
        pointer = packet.writeUInt32BE(this.sequenceNumber, 1);
        // Set address
        var spliAddress = this.address.split('.');
        for(var i in spliAddress){
            pointer = packet.writeUInt8(spliAddress[i], pointer);
        }
        // Set port
        var length = packet.writeUInt16BE(this.port, 9);
        // Set payload
        var finalLength = (this.payload ? packet.write(this.payload, 11, bufferLength-1) : length);
        return packet;
    }

    this.copy = function (){
        return (new Packet())
                    .setType(this.type)
                    .setSequenceNumber(this.sequenceNumber)
                    .setAddress(this.address)
                    .setPort(this.port)
                    .setPayload(this.payload);
    };

    return this;
}

Packet.createFromBuffer = function(buffer){
    var that = new Packet();
    that.setType(buffer.readUInt8(0));
    that.setSequenceNumber(buffer.readUInt32BE(1));
    that.setAddress((new Array(buffer.readUInt8(5), buffer.readUInt8(6), buffer.readUInt8(7), buffer.readUInt8(8))).join('.'));
    that.setPort(buffer.readUInt16BE(9));
    that.setPayload(buffer.toString('ascii', 11));

    return that;
}

Packet.copy = function (packet){
    return (new Packet())
                .setType(packet.type)
                .setSequenceNumber(packet.sequenceNumber)
                .setAddress(packet.address)
                .setPort(packet.port)
                .setPayload(packet.payload);
};

module.exports = Packet; 