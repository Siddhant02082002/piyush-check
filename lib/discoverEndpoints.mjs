import fs from "fs";
import path from "path";
import ts from "typescript";
import esprima from "esprima";
import {
  isTsHttpMethodCall,
  extractBodyForTs,
  extractHeadersForTs,
  extractQueryParamsForTs,
  extractHeadersForJs,
  extractBodyForJs,
  extractQueryParamsForJs,
  isJsHttpMethodCall,
  cloneRepository,
  deleteClonedRepository,
  fetchRepoFiles
} from "./utils.mjs";

// // Function to find API endpoints
export async function discoverEndpoints({
  repoPath,
  framework,
  objectInstance,
  githubAPIKey,
}) {
  console.log("Discovering your APIs...");
  let localPath = "./clonedRepo";
  let isCloned = false;
  try {
    const apiEndpoints = [];
    if (repoPath.startsWith("http://") || repoPath.startsWith("https://")) {


      if(githubAPIKey) {
        await fetchRepoFiles(repoPath, githubAPIKey, localPath);
      }
      else {
        // Clone the repository
        await cloneRepository(repoPath, localPath);
      }
      
      isCloned = true;
    } else {
      // Use the local directory
      localPath = repoPath;
    }

    // Recursively scan directory for route files
    function scanDirectory(dir) {
      const files = fs.readdirSync(dir);

      files.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat.isDirectory()) {
          // Handle directories recursively
          scanDirectory(filePath);
        } else if (stat.isFile() && file.endsWith(".ts")) {
          // Process TypeScript files
          const endpoints = processTsFile(
            file,
            filePath,
            framework,
            objectInstance
          );
          apiEndpoints.push(...endpoints);
        } else if (stat.isFile() && file.endsWith(".js")) {
          // Process JavaScript files
          const endpoints = processJsFile(
            file,
            filePath,
            framework,
            objectInstance
          );
          apiEndpoints.push(...endpoints);
        }
      });
    }

    scanDirectory(localPath);
    return apiEndpoints;
  } catch (err) {
    throw err;
  } finally {
    isCloned && deleteClonedRepository(localPath);
  }
}


// Function to process TypeScript file
function processTsFile(file, filePath, framework, objectInstance) {
  
  const endpoints = [];

  const fileName = path.parse(file).name; // Extract file name without extension

    // Determine resource name and endpoint path
    let resourceName = fileName;
    let endpointPath = `/${resourceName}`;

    // Modify endpoint path if file is not index.ts
    if (fileName !== "index") {
      // Use file name for resource name
      resourceName = fileName;

      // Handle API versioning and resource modules
      const versionMatch = filePath.match(/\/v\d+\//);
      if (versionMatch) {
        const version = versionMatch[0].replace(/\//g, ""); // Extract version from file path
        endpointPath = `/${version}/${resourceName}`;
      } else {
        endpointPath = `/${resourceName}`;
      }
    }

    // Read the file content
    const content = fs.readFileSync(filePath, "utf8");

    // Parse the file content as TypeScript
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    // Process AST to find and extract API endpoints
    traverse(sourceFile, (node) => {
  
      // Look for route definitions based on the specified framework and object instance
      if (
        ts.isCallExpression(node) &&
        node.expression &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression &&
        node.expression.expression.escapedText === objectInstance &&
        isTsHttpMethodCall(node, objectInstance, framework)
      ) {
        const method = node.expression.name.escapedText.toUpperCase();
        const routePath =
          node.arguments[0] && ts.isStringLiteral(node.arguments[0])
            ? node.arguments[0].text
            : "";

        // Extract headers, query parameters, and body (if available)
        const headers = extractHeadersForTs(node);
        const queryParameters = extractQueryParamsForTs(node);
        const body = extractBodyForTs(node); // Pass content of file for body extraction

        // Construct endpoint object
        const endpoint = {
          method: method,
          path: `${endpointPath}${routePath}`,
          headers: headers,
          queryParameters: queryParameters,
          body: body,
          file: filePath,
          resourceName
        };

        endpoints.push(endpoint);
      }
    });
  return endpoints;
}
//////////new//////////
function processJsFile(file, filePath, framework, objectInstance) {
  const endpoints = [];
  const fileName = path.parse(file).name;

  // Read JavaScript files and search for API interactions
  const content = fs.readFileSync(filePath, "utf8");
  let ast;
  try {
    ast = esprima.parseScript(content, { tolerant: true });
  } catch (error) {
    console.error(`Error parsing file ${filePath}:`, error);
    return endpoints;
  }

  // Traverse the AST to find axios or fetch calls
  traverse(ast, (node) => {
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.object.name === 'axios') {
      const method = node.callee.property.name.toUpperCase();  // GET, POST, etc.
      const urlNode = node.arguments[0]; // URL being requested

      let routePath = '';
      if (urlNode.type === 'Literal') {
        routePath = urlNode.value;  // The API endpoint
      } else if (urlNode.type === 'TemplateLiteral') {
        routePath = urlNode.quasis.map(q => q.value.raw).join('');  // If URL uses template strings
      }

      // Collect headers, query params, body if present
      let headers = {};
      let body = null;
      let queryParameters = {};

      if (node.arguments.length > 1 && node.arguments[1].type === 'ObjectExpression') {
        const configObj = node.arguments[1];

        // Loop through config properties
        configObj.properties.forEach(prop => {
          if (prop.key.name === 'headers') {
            headers = extractHeadersFromObject(prop.value);
          } else if (prop.key.name === 'data') {
            body = extractBodyFromObject(prop.value);
          } else if (prop.key.name === 'params') {
            queryParameters = extractQueryParamsFromObject(prop.value);
          }
        });
      }

      const endpoint = {
        method,
        path: routePath,
        headers,
        queryParameters,
        body,
        file: filePath,
        resourceName: fileName
      };

      endpoints.push(endpoint);
    }
  });

  return endpoints;
}

// Helper function to extract headers, query parameters, and body from axios config
function extractHeadersFromObject(node) {
  const headers = {};
  node.properties.forEach(prop => {
    if (prop.key.type === 'Identifier') {
      headers[prop.key.name] = prop.value.value;
    }
  });
  return headers;
}

function extractQueryParamsFromObject(node) {
  const queryParams = {};
  node.properties.forEach(prop => {
    if (prop.key.type === 'Identifier') {
      queryParams[prop.key.name] = prop.value.value;
    }
  });
  return queryParams;
}

function extractBodyFromObject(node) {
  // This will depend on how complex the body is. You might want to extract it based on object properties.
  return node;
}

///////////NEW /////////
// Helper function to traverse AST
function traverse(node, visitor) {
  if (!node) return;

  visitor(node);

  for (const key in node) {
    if (node.hasOwnProperty(key)) {
      const child = node[key];
      if (typeof child === "object" && child !== null) {
        traverse(child, visitor);
      }
    }
  }
}

// Function to process JavaScript files
function processJsFile(file, filePath, framework, objectInstance) {
  const endpoints = [];
  const fileName = path.parse(file).name;

  // Determine resource name and endpoint path
  let resourceName = fileName;
  let endpointPath = `/${resourceName}`;

  // Modify endpoint path if file is not index.js
  if (fileName !== "index") {
    resourceName = fileName;

    const versionMatch = filePath.match(/\/v\d+\//);
    if (versionMatch) {
      const version = versionMatch[0].replace(/\//g, "");
      endpointPath = `/${version}/${resourceName}`;
    } else {
      endpointPath = `/${resourceName}`;
    }
  }

  // Read JavaScript files and search for route definitions based on framework
  const content = fs.readFileSync(filePath, "utf8");
  let ast;
  try {
    ast = esprima.parseScript(content, { tolerant: true });
  } catch (error) {
    console.error(`Error parsing file ${filePath}:`, error);
    return endpoints;
  }

  // Process AST to find and extract API endpoints
  traverse(ast, (node) => {
    // Check for function declarations and function expressions
    if (
      (node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression") &&
      node.body &&
      node.body.body
    ) {
      node.body.body.forEach((bodyNode) => {
        if (
          bodyNode.type === "ExpressionStatement" &&
          bodyNode.expression.type === "CallExpression" &&
          bodyNode.expression.callee.type === "MemberExpression" &&
          bodyNode.expression.callee.object.name === objectInstance &&
          isJsHttpMethodCall(bodyNode.expression, objectInstance, framework)
        ) {
          const method = bodyNode.expression.callee.property.name.toUpperCase();
          const routePath =
            bodyNode.expression.arguments[0] &&
            bodyNode.expression.arguments[0].type === "Literal"
              ? bodyNode.expression.arguments[0].value
              : "";

          const headers = extractHeadersForJs(bodyNode.expression);
          const queryParameters = extractQueryParamsForJs(bodyNode.expression);
          const body = extractBodyForJs(bodyNode.expression, content);

          const endpoint = {
            method: method,
            path: `${endpointPath}${routePath}`,
            headers: headers,
            queryParameters: queryParameters,
            body: body,
            file: filePath,
            resourceName: resourceName,
          };

          endpoints.push(endpoint);
        }
      });
    } else if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.object &&
      node.callee.object.name === objectInstance &&
      isJsHttpMethodCall(node, objectInstance, framework)
    ) {
      const method = node.callee.property.name.toUpperCase();
      const routePath = node.arguments[0].value;

      // Extract headers, query parameters, and body (if available)
      const headers = extractHeadersForJs(node);
      const queryParameters = extractQueryParamsForJs(node);
      const body = extractBodyForJs(node, content); // Pass content of file for body extraction

      // Construct endpoint object
      const endpoint = {
        method: method,
        path: routePath,
        headers: headers,
        queryParameters: queryParameters,
        body: body,
        file: filePath,
        resourceName
      };

      endpoints.push(endpoint);
    }
  });

  return endpoints;
}
