import * as d3 from 'd3';
import config from './config.json' with { type: 'json' };

const x = d3.scaleUtc()
    .domain([new Date("2023-01-01"), new Date("2024-01-01")])
    .range([config.margins.left, config.dimensions.width - config.margins.right]);

const y = d3.scaleLinear()
    .domain([0, 100])
    .range([config.dimensions.height - config.margins.bottom, config.margins.top]);

const svg = d3.create("svg")
    .attr("width", config.dimensions.width)
    .attr("height", config.dimensions.height);

svg.append("g")
    .attr("transform", `translate(0,${config.dimensions.height - config.margins.bottom})`)
    .call(d3.axisBottom(x));

svg.append("g")
    .attr("transform", `translate(${config.margins.left},0)`)
    .call(d3.axisLeft(y));

const container = document.getElementById('visualizer');
const svgNode = svg.node();

if (container && svgNode) {
    container.append(svgNode);
}